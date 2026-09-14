#!/usr/bin/env node
// ============================================================================
// Acceptance gate for the cutover: does the NEW backend serve the same data the
// OLD one did?
//
// migrate-from-sheets.mjs checks that it wrote as many rows as it read. That is
// a check on itself. This reads the new backend back through its own HTTP API —
// the same path the app takes — and diffs it field by field against the backup
// captured from the old one. Two independent artifacts, compared end to end.
//
// It knows about the transformations the migration performs ON PURPOSE, and
// treats only unexplained differences as failures:
//
//   padD4       "1101" and 1101 and "C1101" are the same person
//   deny-list   gpa / fieldOfStudy / smoker / nokOccupation are dropped by
//               design (minimisation), so their absence is not a diff
//   text typing Sheets returned real numbers and booleans; Postgres returns
//               text. 14 vs "14" and true vs "true" are the same value
//   "" vs null  both read as empty
//   not-migrated  Conduct Master / Sheet3 / notes carry no app data and have no
//               table; reported as skipped, not as loss
//
// `id` IS NOT A KEY IN THE SOURCE DATA, and that is the failure this gate is
// really here to catch. In the live Sheet 2,234 rows (every IPPT and PolarFlow
// row) have a BLANK id, and 16 rows share an id with a different record (11
// Medical, 5 Leave — e.g. id=1404 is both d4 4214's back pain and d4 1311's
// fever). The Postgres schema makes id a primary key, so an import silently
// drops the blank ones and collapses the duplicated ones. An earlier version of
// this script joined both sides through a Map keyed on id, which collapsed the
// OLD side exactly as the import collapsed the new one, compared 1038 against
// 1038, and reported success over 16 destroyed records. So:
//
//   * raw row counts are compared per tab FIRST, with no key involved at all,
//     and any shortfall fails on its own
//   * duplicate keys are counted on both sides and reported explicitly; rows
//     are grouped by key, not overwritten, so a 2 → 1 collapse is visible
//   * blank-key rows are counted per tab and reported; any that exist in the
//     backup and not in the new backend are data loss and fail
//
// SINCE ids CARRY NO MEANING, the importer is now allowed to assign new ones —
// but only where the source id is blank or collides with a different record.
// Every assignment is recorded in <backup>/id-map.json, and this gate reads
// that file so it can follow a renamed row to its new home WITHOUT loosening
// anything above:
//
//   * the mapping is applied to the OLD rows before the join, so the old row at
//     rowIndex N is compared against the new row carrying its mapped newId
//   * a mapped row is still diffed field by field; only `id` is exempt, and
//     only for that row, because its change is the thing the mapping records
//   * a blank-id row the mapping does NOT account for is still a failure
//   * raw row counts stay absolute — mapping or no mapping, 875 in is 875 out
//   * the mapping itself is verified (no newId used twice, no newId colliding
//     with a preserved id, every rowIndex real). A broken mapping is
//     indistinguishable from data loss, so it fails loudly rather than being
//     trusted.
//
// With no id-map.json present the gate behaves exactly as it did before.
//
// Values are NOT printed by default — this is real personnel data and the
// output tends to end up in a terminal log. Pass --show-values when you are
// actually debugging a mismatch.
//
// Usage:
//   NEW_API_URL=https://<ref>.supabase.co/functions/v1/api \
//   NEW_AUTH=<token> \
//     node scripts/verify-migration.mjs ~/cougar-backups/<stamp> [--show-values]
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Mirrors padD4 (js/state.js:284) — the one transformation applied to keys.
export const padD4 = (v) => {
  const s = String(v ?? "").trim().replace(/^C/i, "");
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
};

// Dropped on purpose by the importer, so their absence downstream is correct.
export const DENY = { Roster: new Set(["gpa", "fieldOfStudy", "smoker", "nokOccupation"]) };
export const NO_ID = new Set(["MSK", "Config"]);
// No table, by design: no app reads them.
export const NOT_MIGRATED = new Set(["Conduct Master", "Sheet3", "notes"]);

// A Sheets number and a Postgres text column holding the same value must
// compare equal, or every numeric field in the system reads as a diff.
export const norm = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v).trim();
  if (s === "") return "";
  // 1101 vs "1101" already match; this catches 14 vs "14.0" and 2.50 vs "2.5".
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(n);
  }
  if (/^(true|false)$/i.test(s)) return s.toLowerCase();
  return s;
};

export const rowKey = (r) => padD4(r?.id ?? r?.["4d"] ?? "");

// Group rows by key WITHOUT losing duplicates — a Map of key → rows[] rather
// than key → row. The last-write-wins Map is precisely the bug this replaces.
function groupByKey(rows) {
  const groups = new Map();
  const blank = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (!k) { blank.push(r); continue; }
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return { groups, blank };
}

function dupSummary(groups) {
  let keys = 0, rows = 0;
  const examples = [];
  for (const [k, rs] of groups) {
    if (rs.length < 2) continue;
    keys++;
    rows += rs.length;
    if (examples.length < 5) examples.push(`${k}×${rs.length}`);
  }
  return { keys, rows, examples };
}

// ---------------------------------------------------------------------------
// id-map.json — the record of every id the importer assigned.
// ---------------------------------------------------------------------------

export const ID_MAP_FILE = "id-map.json";

/**
 * Read <backupDir>/id-map.json.
 *
 * Returns null when the file does not exist — an unmapped backup is a valid
 * input and the gate must still work on it. Anything else (unreadable, not
 * JSON, wrong shape) THROWS: a mapping we cannot read is not the same as no
 * mapping, and quietly downgrading one to the other is how a mapping bug gets
 * mistaken for a clean run.
 */
export function loadIdMap(backupDir) {
  const file = path.join(backupDir, ID_MAP_FILE);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`${file} exists but could not be read: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  return parseIdMap(parsed, file);
}

/** Shape-check a parsed id-map. Throws with a pointed message, never guesses. */
export function parseIdMap(parsed, where = ID_MAP_FILE) {
  const bad = (msg) => { throw new Error(`${where} is malformed: ${msg}`); };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) bad("expected an object at the top level");
  if (!parsed.tabs || typeof parsed.tabs !== "object" || Array.isArray(parsed.tabs)) bad("expected a `tabs` object");

  const tabs = new Map();
  for (const [tab, entries] of Object.entries(parsed.tabs)) {
    if (!Array.isArray(entries)) bad(`tabs["${tab}"] must be an array of entries`);
    entries.forEach((e, i) => {
      const at = `tabs["${tab}"][${i}]`;
      if (!e || typeof e !== "object" || Array.isArray(e)) bad(`${at} must be an object`);
      if (!Number.isInteger(e.rowIndex) || e.rowIndex < 0) bad(`${at}.rowIndex must be a non-negative integer`);
      if (typeof e.newId !== "string" || e.newId.trim() === "") bad(`${at}.newId must be a non-empty string`);
      if (!("oldId" in e)) bad(`${at} is missing oldId`);
      if (e.oldId !== null && e.oldId !== undefined && typeof e.oldId !== "string" && typeof e.oldId !== "number") {
        bad(`${at}.oldId must be a string, a number, or empty`);
      }
    });
    tabs.set(tab, entries);
  }
  return { generatedAt: parsed.generatedAt ?? null, tabs };
}

/**
 * Prove the mapping for one tab is internally sound against the backup rows it
 * claims to describe. Returns a list of problems; empty means sound.
 *
 * A mapping error looks exactly like data loss from the outside (a row is not
 * where the gate went looking for it), so none of these may be tolerated.
 */
export function validateMapping(tab, entries, oldRows) {
  const problems = [];
  if (!entries || !entries.length) return problems;

  const seenIndex = new Map();
  const seenNewId = new Map();

  for (const e of entries) {
    const at = `mapping rowIndex=${e.rowIndex}`;

    // Every mapped rowIndex must exist in the backup — the index is the only
    // link back to the source row, so a stale one maps nothing.
    if (e.rowIndex >= oldRows.length) {
      problems.push(`${at}: no such row in the backup (tab has ${oldRows.length} row(s)) — the mapping does not describe this backup`);
      continue;
    }

    if (seenIndex.has(e.rowIndex)) {
      problems.push(`${at}: mapped twice (to ${seenIndex.get(e.rowIndex)} and ${e.newId})`);
    } else {
      seenIndex.set(e.rowIndex, e.newId);
    }

    const newKey = padD4(e.newId);
    if (seenNewId.has(newKey)) {
      problems.push(`mapping assigns newId=${newKey} to both rowIndex=${seenNewId.get(newKey)} and rowIndex=${e.rowIndex}` +
                    ` — a reused newId collapses two records into one`);
    } else {
      seenNewId.set(newKey, e.rowIndex);
    }

    // The mapping must agree with the backup about what it is renaming; if it
    // does not, it was generated against different data.
    const actualOld = norm(padD4(oldRows[e.rowIndex]?.id));
    const claimedOld = norm(padD4(e.oldId));
    if (actualOld !== claimedOld) {
      problems.push(`${at}: mapping says oldId was ${JSON.stringify(claimedOld)} but the backup row has ` +
                    `${JSON.stringify(actualOld)} — the mapping does not describe this backup`);
    }
  }

  // A newId that lands on an id some OTHER row kept is a collision the importer
  // created, and one of the two rows will lose.
  const mappedIdx = new Set(entries.map((e) => e.rowIndex));
  const preserved = new Map();
  oldRows.forEach((r, i) => {
    if (mappedIdx.has(i)) return;
    const k = rowKey(r);
    if (k && !preserved.has(k)) preserved.set(k, i);
  });
  for (const [newKey, idx] of seenNewId) {
    if (preserved.has(newKey)) {
      problems.push(`mapping assigns newId=${newKey} to rowIndex=${idx}, but rowIndex=${preserved.get(newKey)} ` +
                    `PRESERVES that same id — the assignment collides with an untouched row`);
    }
  }

  return problems;
}

/**
 * Apply a tab's mapping to the backup rows: the row at rowIndex N takes its
 * newId. Returns the rewritten rows plus a Set of the rewritten objects, so the
 * field diff knows which rows are allowed to have a different id.
 */
function applyMapping(oldRows, entries) {
  if (!entries || !entries.length) return { rows: oldRows, mapped: new Set() };
  const byIndex = new Map(entries.map((e) => [e.rowIndex, e.newId]));
  const mapped = new Set();
  const rows = oldRows.map((r, i) => {
    if (!byIndex.has(i)) return r;
    const copy = { ...r, id: byIndex.get(i) };
    mapped.add(copy);
    return copy;
  });
  return { rows, mapped };
}

// Field-by-field diff of one old row against one new row, honouring every
// deliberate-difference exemption.
// `skipId` is set ONLY for a row the mapping accounts for: its id changed on
// purpose and the change is recorded, so it is not a diff. Every other field is
// still compared exactly as before.
function diffRow(tab, o, n, label, showValues, problems, skipId = false) {
  const denied = DENY[tab] ?? new Set();
  const fields = new Set([...Object.keys(o), ...Object.keys(n)]);
  const before = problems.length;
  for (const f of fields) {
    if (denied.has(f)) continue;
    if (skipId && f === "id") continue;
    const a = norm(f === "id" || f === "d4" ? padD4(o[f]) : o[f]);
    const b = norm(f === "id" || f === "d4" ? padD4(n[f]) : n[f]);
    if (a !== b) {
      problems.push(showValues ? `${label} ${f}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`
                               : `${label} ${f} differs`);
    }
  }
  return problems.length === before;
}

/**
 * Compare one tab. Pure: no I/O, no process state — this is what the unit
 * tests drive.
 *
 * `opts.mapping` is this tab's array of id-map entries (or undefined for an
 * unmapped tab / an unmapped backup).
 *
 * Returns { problems, notes, comparedRows, matched }. `problems` non-empty =
 * the tab FAILS. `notes` are counts worth printing even when the tab passes
 * (blank keys), so nothing is ever skipped silently. `matched` is the per-tab
 * tally { preserved, mapped, failed }.
 */
export function compareTab(tab, oldRows, newRows, opts = {}) {
  const showValues = !!opts.showValues;
  const problems = [];
  const notes = [];
  const matched = { preserved: 0, mapped: 0, failed: 0 };
  let comparedRows = 0;

  // (1) RAW ROW COUNTS. No key involved, so no amount of key weirdness on
  // either side can hide a row that stopped existing.
  if (oldRows.length !== newRows.length) {
    const delta = newRows.length - oldRows.length;
    problems.push(delta < 0
      ? `row count ${oldRows.length} → ${newRows.length}: ${-delta} row(s) LOST`
      : `row count ${oldRows.length} → ${newRows.length}: ${delta} unexplained extra row(s)`);
  }

  // No key to join on — the raw count above is the whole test for these.
  if (NO_ID.has(tab)) return { problems, notes, comparedRows, matched };

  // (1b) THE MAPPING ITSELF. Verified before it is used: an unsound mapping
  // would silently redirect the join, which reads exactly like data loss.
  const entries = opts.mapping ?? [];
  if (entries.length) {
    const mapProblems = validateMapping(tab, entries, oldRows);
    if (mapProblems.length) {
      problems.push(...mapProblems);
      problems.push(`id-map for ${tab} is not sound — refusing to join through it; ` +
                    `fix the mapping and re-run (a mapping error is indistinguishable from data loss)`);
      return { problems, notes, comparedRows, matched };
    }
    notes.push(`id-map: ${entries.length} of ${oldRows.length} row(s) were assigned a new id by the importer`);
  }

  const { rows: effectiveOld, mapped: mappedRows } = applyMapping(oldRows, entries);

  const oldSide = groupByKey(effectiveOld);
  const newSide = groupByKey(newRows);

  // (2) DUPLICATE KEYS. A duplicated id means the key is not a key, so the
  // join below cannot be trusted — say so out loud instead of collapsing it.
  // With a mapping in play the collisions are resolved by construction, but the
  // SOURCE still had them and a human should see that the importer intervened.
  if (entries.length) {
    const rawDup = dupSummary(groupByKey(oldRows).groups);
    if (rawDup.keys) {
      notes.push(`the backup itself has ${rawDup.keys} duplicated id(s) covering ${rawDup.rows} rows ` +
                 `(${rawDup.examples.join(", ")}${rawDup.keys > rawDup.examples.length ? ", …" : ""}); ` +
                 `the id-map reassigns them`);
    }
  }

  const oldDup = dupSummary(oldSide.groups);
  const newDup = dupSummary(newSide.groups);
  if (oldDup.keys) {
    problems.push(`duplicate id in the BACKUP: ${oldDup.keys} id(s) covering ${oldDup.rows} rows` +
                  ` (${oldDup.examples.join(", ")}${oldDup.keys > oldDup.examples.length ? ", …" : ""})` +
                  ` — id is not a key here, so a primary key on id destroys ${oldDup.rows - oldDup.keys} record(s)`);
  }
  if (newDup.keys) {
    problems.push(`duplicate id in the NEW backend: ${newDup.keys} id(s) covering ${newDup.rows} rows` +
                  ` (${newDup.examples.join(", ")}${newDup.keys > newDup.examples.length ? ", …" : ""})`);
  }

  // (3) BLANK KEYS. Counted and reported, never silently skipped. The importer
  // drops rows with no id, so a shortfall here is exactly that data loss.
  if (oldSide.blank.length || newSide.blank.length) {
    notes.push(`blank id: ${oldSide.blank.length} row(s) in the backup, ${newSide.blank.length} in the new backend`);
    // Once the importer starts assigning ids, EVERY blank one is supposed to be
    // in the mapping. One that is not was left behind, and the primary key
    // drops it.
    if (entries.length && oldSide.blank.length) {
      problems.push(`${oldSide.blank.length} blank-id row(s) in the backup are NOT accounted for by the id-map ` +
                    `— a row with no id and no assignment cannot survive a primary key on id`);
      matched.failed += oldSide.blank.length;
    } else if (oldSide.blank.length > newSide.blank.length) {
      problems.push(`${oldSide.blank.length - newSide.blank.length} blank-id row(s) in the backup are not in the ` +
                    `new backend (${oldSide.blank.length} → ${newSide.blank.length}) — rows with no id are DROPPED, not migrated`);
    }
  }

  // Keyed rows, compared with multiplicity so a 2 → 1 collapse shows up.
  for (const [k, oGroup] of oldSide.groups) {
    const nGroup = newSide.groups.get(k) ?? [];
    if (!nGroup.length) {
      problems.push(`missing row id=${k}${oGroup.length > 1 ? ` (${oGroup.length} rows)` : ""}`);
      matched.failed += oGroup.length;
      continue;
    }
    if (nGroup.length < oGroup.length) {
      problems.push(`id=${k} COLLAPSED: ${oGroup.length} distinct rows in the backup → ${nGroup.length} in the new backend`);
      matched.failed += oGroup.length - nGroup.length;
    }
    const pairs = Math.min(oGroup.length, nGroup.length);
    for (let i = 0; i < pairs; i++) {
      const label = oGroup.length > 1 ? `id=${k}[${i}]` : `id=${k}`;
      const wasMapped = mappedRows.has(oGroup[i]);
      const clean = diffRow(tab, oGroup[i], nGroup[i], label, showValues, problems, wasMapped);
      if (!clean) matched.failed++;
      else if (wasMapped) matched.mapped++;
      else matched.preserved++;
      comparedRows++;
    }
  }
  for (const [k, nGroup] of newSide.groups) {
    if (!oldSide.groups.has(k)) problems.push(`extra row id=${k}${nGroup.length > 1 ? ` (${nGroup.length} rows)` : ""}`);
  }

  return { problems, notes, comparedRows, matched };
}

// ---------------------------------------------------------------------------
// Driver (only when run as a script, so the logic above stays importable).
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const SHOW = argv.includes("--show-values");
  const BACKUP = (argv.find((a) => !a.startsWith("--")) || "").replace(/^~/, os.homedir());
  const { NEW_API_URL, NEW_AUTH } = process.env;

  if (!BACKUP || !NEW_API_URL || !NEW_AUTH) {
    console.error("Usage: NEW_API_URL=... NEW_AUTH=... node scripts/verify-migration.mjs <backup-dir>");
    process.exit(1);
  }

  async function newApi(action, tab = "") {
    const url = `${NEW_API_URL}?action=${action}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}` +
                `&auth=${encodeURIComponent(NEW_AUTH)}`;
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    const body = await res.json();
    if (body?.error) throw new Error(`${action} ${tab}: ${body.error}`);
    return body;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(BACKUP, "manifest.json"), "utf8"));

  // A mapping we cannot parse aborts the run before anything is compared: it is
  // the difference between "this row moved" and "this row is gone".
  let idMap = null;
  try {
    idMap = loadIdMap(BACKUP);
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  console.log(`Backup   ${manifest.takenAt}  (${manifest.totalRows} rows, build ${manifest.backendBuild})`);
  if (idMap) {
    let assigned = 0;
    for (const entries of idMap.tabs.values()) assigned += entries.length;
    console.log(`id-map   ${path.join(BACKUP, ID_MAP_FILE)}  (${assigned} assigned id(s) across ${idMap.tabs.size} tab(s)` +
                `${idMap.generatedAt ? `, generated ${idMap.generatedAt}` : ""})`);
  } else {
    console.log(`id-map   none — every id is expected to be preserved exactly`);
  }
  console.log(`New API  ${NEW_API_URL}\n`);

  let failures = 0, skipped = 0, comparedRows = 0, comparedTabs = 0, oldTotal = 0, newTotal = 0;
  let totalPreserved = 0, totalMapped = 0;

  for (const t of manifest.tabs) {
    if (!t.file) continue;
    if (NOT_MIGRATED.has(t.tab)) {
      console.log(`  skip     ${t.tab.padEnd(16)} not migrated by design (${t.rows} rows stay in the backup)`);
      skipped++;
      continue;
    }

    const oldRows = JSON.parse(fs.readFileSync(path.join(BACKUP, "tabs", t.file), "utf8"));
    let newRows;
    try {
      const res = await newApi("read", t.tab);
      newRows = Array.isArray(res) ? res : (res?.rows ?? []);
    } catch (err) {
      console.log(`  FAIL     ${t.tab.padEnd(16)} ${err.message}`);
      failures++;
      continue;
    }

    const { problems, notes, comparedRows: n, matched } = compareTab(t.tab, oldRows, newRows, {
      showValues: SHOW,
      mapping: idMap?.tabs.get(t.tab),
    });
    comparedRows += n;
    totalPreserved += matched.preserved;
    totalMapped += matched.mapped;
    comparedTabs++;
    oldTotal += oldRows.length;
    newTotal += newRows.length;

    if (problems.length) {
      failures++;
      console.log(`  FAIL     ${t.tab.padEnd(16)} ${oldRows.length} → ${newRows.length} rows, ${problems.length} problem(s)`);
      for (const p of problems.slice(0, 10)) console.log(`             ${p}`);
      if (problems.length > 10) console.log(`             … and ${problems.length - 10} more`);
    } else {
      console.log(`  ok       ${t.tab.padEnd(16)} ${String(newRows.length).padStart(5)} rows match`);
    }
    if (!NO_ID.has(t.tab)) {
      console.log(`             matched: ${matched.preserved} by preserved id, ${matched.mapped} via the id-map, ` +
                  `${matched.failed} failed`);
    }
    for (const note of notes) console.log(`             note: ${note}`);
  }

  console.log(`\n  ${comparedTabs} tabs compared, ${oldTotal} rows in the backup vs ${newTotal} served by the new ` +
              `backend, ${comparedRows} rows checked field by field ` +
              `(${totalPreserved} by preserved id, ${totalMapped} via the id-map), ${skipped} skipped by design.`);
  if (failures) {
    console.log(`  ${failures} tab(s) DO NOT match. Do not cut over.`);
    if (!SHOW) console.log(`  Re-run with --show-values to see the actual differences.`);
    process.exit(1);
  }
  console.log(`  The new backend serves what the old one served.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
