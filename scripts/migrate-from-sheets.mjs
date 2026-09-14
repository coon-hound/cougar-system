#!/usr/bin/env node
// ============================================================================
// One-shot import: live Google Sheet → Postgres.
//
// Re-runnable and idempotent, so the cutover can be rehearsed as often as you
// like before the real one.
//
// WHY IT PULLS THROUGH THE LIVE API RATHER THAN THE XLSX EXPORT
// ------------------------------------------------------------
// The `d4` join key is stored inconsistently in the spreadsheet: IPPT and
// PolarFlow hold it as a Sheets NUMBER, Medical holds it as TEXT. Read the
// xlsx directly and you get "1101.0" for the numeric ones — and padD4 does NOT
// normalise that (it only pads 1-3 digit values), so every record for that
// person would silently fail to join. Apps Script's getValues() coerces to a
// real number first, and JSON gives 1101, which padD4 handles. So the export
// is a reference, never the import source.
//
// Usage:
//   APPS_SCRIPT_URL=... COUGAR_AUTH=... DATABASE_URL=... COUGAR_ENC_KEY=... \
//     node scripts/migrate-from-sheets.mjs [--commit]
//
// Dry run by default: fetches, transforms, reports counts, writes nothing.
// ============================================================================

import postgres from "postgres";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { APPS_SCRIPT_URL, COUGAR_AUTH, DATABASE_URL, COUGAR_ENC_KEY } = process.env;
const COMMIT = process.argv.includes("--commit");

// --backup <dir> does two things, both about making the verification chain
// sound rather than merely present:
//
//   1. It REFUSES TO COMMIT if the live sheet has drifted from the backup. The
//      acceptance gate diffs the new backend against that backup, so if the
//      sheet changed in between, the gate is comparing against something that
//      was never imported and its verdict means nothing. Better to re-backup.
//   2. It writes id-map.json recording every id this import assigns, so the
//      gate can still match old rows to new ones it deliberately re-keyed.
const bIdx = process.argv.indexOf("--backup");
const BACKUP = bIdx > -1 ? (process.argv[bIdx + 1] || "").replace(/^~/, os.homedir()) : "";
const FORCE_DRIFT = process.argv.includes("--ignore-drift");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

for (const [k, v] of Object.entries({ APPS_SCRIPT_URL, COUGAR_AUTH, DATABASE_URL, COUGAR_ENC_KEY })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

// readAll key → { tab, table }. Keys are the ones readAllTabs emits
// (apps-script-Code.gs:794-808); note rm / polar / conductDetail differ from
// their tab names.
const TRACKED = {
  roster:        { tab: "Roster",        table: "roster" },
  medical:       { tab: "Medical",       table: "medical" },
  attendance:    { tab: "Attendance",    table: "attendance" },
  ippt:          { tab: "IPPT",          table: "ippt" },
  rm:            { tab: "RouteMarch",    table: "routemarch" },
  soc:           { tab: "SOC",           table: "soc" },
  polar:         { tab: "PolarFlow",     table: "polarflow" },
  conductDetail: { tab: "ConductDetail", table: "conductdetail" },
  appointments:  { tab: "Appointments",  table: "appointments" },
  leave:         { tab: "Leave",         table: "leave" },
  msk:           { tab: "MSK",           table: "msk" },
  conducts:      { tab: "Conducts",      table: "conducts" },
};

// Not in readAll — fetched individually via read&tab.
const UNTRACKED = {
  ParadeStates: "paradestates",
  TgUsers:      "tgusers",
  ReportSick:   "reportsick",
  Config:       "config",
};

const ENCRYPTED = new Set([
  "dob", "bloodType", "allergies", "otherMedical",
  "address", "nokName", "nokRelation", "nokPhone",
]);

// Deliberately not migrated (plan §4.6, and absent from the 0001 schema).
// Without this the fields would land in `extra` and quietly survive the very
// minimisation they were dropped for.
const DENY = { Roster: new Set(["gpa", "fieldOfStudy", "smoker", "nokOccupation"]) };

const NO_ID = new Set(["MSK", "Config"]);

// Mirrors padD4 (js/state.js:284) exactly: strip a leading "C", then left-pad
// 1-3 digit values to 4 so commander "1" survives as "0001".
const padD4 = (v) => {
  const s = String(v ?? "").trim().replace(/^C/i, "");
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
};

// Apps Script intermittently answers a heavy read with a 404 HTML error page
// instead of JSON — observed on readAll (a 1 MB response) roughly one attempt in
// three, failing after ~25s while a light revCheck on the same token succeeds
// instantly. It is transient: the immediate retry returns the full payload.
//
// Retry rather than let it kill the run. The import is one transaction, so a
// mid-fetch failure is safe — it simply aborts before writing — but a cutover
// that has to be restarted because of a flaky read is a cutover that happens
// under time pressure, which is when mistakes get made.
async function api(action, tab, attempt = 1) {
  const MAX = 5;
  const url = `${APPS_SCRIPT_URL}?action=${action}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}` +
              `&auth=${encodeURIComponent(COUGAR_AUTH)}`;
  const label = `${action}${tab ? ` ${tab}` : ""}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON means the gateway failed, not that the data is bad.
      throw new Error(`${label}: HTTP ${res.status}, non-JSON response (${text.length} bytes)`);
    }
    if (body?.error) throw new Error(`${label}: ${body.error}`);   // a real API error — do not retry
    return body;
  } catch (e) {
    const retryable = /non-JSON response|fetch failed|timed out|terminated|ETIMEDOUT|ECONNRESET/i.test(e.message);
    if (!retryable || attempt >= MAX) throw e;
    const wait = 2000 * attempt;
    console.log(`  ${label} failed (${e.message}) — retry ${attempt}/${MAX - 1} in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
    return api(action, tab, attempt + 1);
  }
}

// ── Transform ───────────────────────────────────────────────────────────────

function shape(tab, row, columns) {
  const denied = DENY[tab] ?? new Set();
  const real = {}, extra = {};
  for (const [k, v] of Object.entries(row)) {
    if (denied.has(k)) continue;
    const val = v == null ? null : String(v);
    if (columns.has(k)) real[k] = val;
    else extra[k] = val;
  }

  // Roster's primary key is the canonical digit-only 4D.
  //   "4d" holds the DISPLAY form   ("C1101")
  //   "id" holds the CANONICAL form ("1101") — what every child d4 joins to
  // normalizeRoster (js/state.js:293) prefers `id` and falls back to `4d`, and
  // 26 of 282 live rows (all Commanders, whose 4D looks like "0001") carry
  // only `4d`. The PK cannot be null, so derive it the same way.
  if (tab === "Roster") real.id = padD4(real.id || real["4d"] || "");

  // Every child table joins on d4; normalise it the way padD4OnLayer does
  // (js/state.js:368) so the numeric/text inconsistency at source disappears.
  if ("d4" in real) real.d4 = padD4(real.d4);

  return { real, extra };
}

// ── Id assignment ───────────────────────────────────────────────────────────
//
// The live sheet's `id` is not a key. It is blank on every IPPT (875) and
// PolarFlow (1,359) row, and on 16 rows it belongs to a DIFFERENT record — one
// Medical id covers both a back injury in May and a fever in July, for two
// different people, because the old client seeded its id counter from
// Math.random() once per session and two devices collided.
//
// The ids are randomly assigned and carry no meaning, so re-keying is safe. We
// still assign the MINIMUM: every id that is already non-blank and unique is
// preserved untouched. Two reasons, both about verification rather than taste —
// a preserved id lets the acceptance gate match old row to new row directly,
// and the fewer rows we re-key, the fewer rows whose correctness rests on the
// mapping file being right.
//
// A new id is `m-` plus 12 hex of a hash over (tab, row position, row content):
//   * the `m-` prefix can never be confused with a legacy numeric id, and keeps
//     `+id` NaN rather than a truthy number (the coercion bug in js/forms.js);
//   * row position is in the hash because content alone is NOT unique — 44
//     PolarFlow rows are identical to another row on person, date, conduct and
//     duration, and collapsing those would be exactly the data loss this
//     migration exists to avoid;
//   * it is deterministic, so re-running the import over the same source
//     produces the same ids and the import stays idempotent.
function assignIds(tab, rows) {
  const seen = new Set();
  const assignments = [];
  const ids = rows.map((row, rowIndex) => {
    const raw = String(row?.id ?? "").trim();
    if (raw && !seen.has(raw)) { seen.add(raw); return raw; }

    const reason = raw ? "collision" : "blank";
    const newId = "m-" + sha256(`${tab}|${rowIndex}|${JSON.stringify(row)}`).slice(0, 12);
    seen.add(newId);
    assignments.push({
      rowIndex, oldId: raw, newId, reason,
      key: { d4: row?.d4 ?? row?.["4d"] ?? "", date: row?.date ?? row?.startDate ?? "",
             attempt: row?.attempt ?? "" },
      contentHash: sha256(JSON.stringify(row)),
    });
    return newId;
  });
  return { ids, assignments };
}

async function columnsOf(sql, table) {
  const rows = await sql`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = ${table}`;
  return new Set(
    rows.map((r) => r.column_name)
      .filter((c) => !["extra", "updated_at", "deleted_at", "_pk"].includes(c)),
  );
}

// ── Load ────────────────────────────────────────────────────────────────────

// Load a whole tab.
//
// SET-BASED, NOT ROW-BY-ROW. The first version issued an insert AND an update
// per row — about 13,000 sequential round trips for 6,631 rows, all inside one
// transaction. Against a pooled connection to ap-southeast-1 that is minutes of
// pure latency, and Supabase's session pooler closed the connection before it
// finished (`write CONNECTION_CLOSED`). The transaction rolled back cleanly, so
// nothing was lost — but a cutover whose import takes an hour is a cutover that
// runs out of window, and that is when mistakes get made.
//
// Chunked multi-row inserts take it to a few dozen round trips. Roster keeps a
// per-row path because its eight encrypted columns each need enc_col() applied
// to that row's value; at 282 rows that is cheap.
const CHUNK = 500;

async function loadTable(sql, tab, table, rows, assignedIds) {
  const columns = await columnsOf(sql, table);
  let written = 0, skipped = 0;

  // Shape every row up front so the whole tab is one set of values.
  const shaped = [];
  for (let i = 0; i < rows.length; i++) {
    const { real, extra } = shape(tab, rows[i], columns);
    if (assignedIds && tab !== "Roster") real.id = assignedIds[i];
    if (!NO_ID.has(tab) && !real.id) { skipped++; continue; }
    shaped.push({ real, extra });
  }

  // ── Roster: per row, because each encrypted column is a function of its own
  //    value. 282 rows x 2 statements is well inside any timeout.
  if (tab === "Roster") {
    for (const { real, extra } of shaped) {
      await sql`insert into ${sql(table)} ("id") values (${real.id})
                on conflict ("id") do nothing`;
      const assign = Object.keys(real).map((k) =>
        ENCRYPTED.has(k)
          ? sql`${sql(k)} = enc_col(${real[k]}, ${COUGAR_ENC_KEY})`
          : sql`${sql(k)} = ${real[k]}`);
      await sql`update ${sql(table)}
                   set ${assign.reduce((a, b) => sql`${a}, ${b}`)},
                       extra = ${sql.json(extra)}, deleted_at = null
                 where "id" = ${real.id}`;
      written++;
    }
    return { written, skipped };
  }

  // ── Everything else: chunked multi-row insert.
  // Build one uniform column list for the tab so every row in a chunk has the
  // same shape — a missing key in one row would otherwise shift the values.
  const cols = [...new Set(shaped.flatMap(({ real }) => Object.keys(real)))];

  for (let i = 0; i < shaped.length; i += CHUNK) {
    const chunk = shaped.slice(i, i + CHUNK);
    const values = chunk.map(({ real, extra }) => {
      const o = {};
      for (const c of cols) o[c] = real[c] ?? null;
      o.extra = sql.json(extra);
      return o;
    });
    const insertCols = [...cols, "extra"];

    if (NO_ID.has(tab)) {
      // No id column, so no conflict target — these tables are only ever
      // replaced wholesale, and the surrogate _pk is assigned by the sequence.
      await sql`insert into ${sql(table)} ${sql(values, ...insertCols)}`;
    } else {
      const upd = insertCols
        .filter((c) => c !== "id")
        .map((c) => sql`${sql(c)} = excluded.${sql(c)}`)
        .reduce((a, b) => sql`${a}, ${b}`);
      await sql`
        insert into ${sql(table)} ${sql(values, ...insertCols)}
        on conflict ("id") do update set ${upd}, deleted_at = null`;
    }
    written += chunk.length;
  }
  return { written, skipped };
}

// ── Main ────────────────────────────────────────────────────────────────────

const sql = postgres(DATABASE_URL, { prepare: false, max: 4 });

try {
  console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run (pass --commit to write)\n");

  console.log("Fetching readAll from the live Apps Script …");
  const all = await api("readAll");

  const source = {};
  for (const [key, { tab, table }] of Object.entries(TRACKED)) {
    source[tab] = { table, rows: Array.isArray(all[key]) ? all[key] : [] };
  }
  for (const [tab, table] of Object.entries(UNTRACKED)) {
    process.stdout.write(`Fetching ${tab} … `);
    const res = await api("read", tab);
    const rows = Array.isArray(res) ? res : (res?.rows ?? []);
    source[tab] = { table, rows: Array.isArray(rows) ? rows : [] };
    console.log(`${source[tab].rows.length} rows`);
  }

  // ── Drift guard + id assignment ─────────────────────────────────────────
  const idPlan = {};
  for (const [tab, { rows }] of Object.entries(source)) {
    // Roster keys off padD4(4D) and is never re-keyed; MSK and Config have no
    // `id` column at all (a surrogate _pk is their key), so there is nothing to
    // assign for either.
    idPlan[tab] = (tab === "Roster" || NO_ID.has(tab))
      ? { ids: null, assignments: [] }
      : assignIds(tab, rows);
  }

  if (BACKUP) {
    const manifest = JSON.parse(fs.readFileSync(path.join(BACKUP, "manifest.json"), "utf8"));
    const drifted = [];
    for (const t of manifest.tabs) {
      if (!t.file || !(t.tab in source)) continue;
      // Hash the live rows exactly as backup-sheets.mjs hashed them, so the two
      // numbers are comparable at all.
      if (sha256(JSON.stringify(source[t.tab].rows, null, 2)) !== t.sha256) {
        drifted.push(`${t.tab} (backup ${t.rows} rows)`);
      }
    }
    if (drifted.length) {
      console.error(`\nTHE LIVE SHEET HAS CHANGED since the backup was taken (${manifest.takenAt}):`);
      for (const d of drifted) console.error(`  ${d}`);
      console.error(`\nThe acceptance gate diffs the new backend against that backup, so importing`);
      console.error(`now would have it compare against data that was never imported — a verdict`);
      console.error(`that means nothing. Take a fresh backup and re-run.`);
      if (!FORCE_DRIFT) process.exit(1);
      console.error(`--ignore-drift set; continuing anyway.\n`);
    } else {
      console.log(`\nLive sheet matches the backup taken ${manifest.takenAt} — safe to import.`);
    }
  }

  const reKeyed = Object.values(idPlan).reduce((n, p) => n + p.assignments.length, 0);
  if (reKeyed) {
    console.log(`\nIDS ASSIGNED BY THIS IMPORT (${reKeyed} rows — the source id was blank or already taken):`);
    for (const [tab, plan] of Object.entries(idPlan)) {
      if (!plan.assignments.length) continue;
      const blank = plan.assignments.filter((a) => a.reason === "blank").length;
      const coll  = plan.assignments.filter((a) => a.reason === "collision").length;
      console.log(`  ${tab.padEnd(16)} ${String(plan.assignments.length).padStart(5)}` +
                  `   (${blank} blank, ${coll} collision${coll === 1 ? "" : "s"})`);
      for (const a of plan.assignments.filter((x) => x.reason === "collision")) {
        console.log(`      row ${a.rowIndex}: id ${a.oldId} was already used by an earlier row -> ${a.newId}`);
      }
    }
  }

  console.log("\n" + "tab".padEnd(16) + "source".padStart(8) +
              "written".padStart(9) + "skipped".padStart(9));
  console.log("-".repeat(46));

  // A dry run that only counts source rows proves nothing about whether the
  // import would work. Run the real transform against the real target schema —
  // read-only — so schema drift shows up BEFORE the cutover rather than as
  // silently-shelved data afterwards.
  const audit = {};
  for (const [tab, { table, rows }] of Object.entries(source)) {
    const columns = await columnsOf(sql, table);
    if (!columns.size) { audit[tab] = { missingTable: true }; continue; }
    const unknown = new Set(), denied = new Set(), encrypted = new Set();
    let noId = 0;
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const { real, extra } = shape(tab, raw, columns);
      for (const k of Object.keys(extra)) unknown.add(k);
      for (const k of Object.keys(raw)) if ((DENY[tab] ?? new Set()).has(k)) denied.add(k);
      for (const k of Object.keys(real)) if (ENCRYPTED.has(k)) encrypted.add(k);
      // Count against the id this import will actually WRITE, not the source's.
      // Indexed, not indexOf: 44 PolarFlow rows are byte-identical to another
      // row, so a value search would keep resolving to the first of the pair.
      const assigned = idPlan[tab].ids;
      const effectiveId = assigned ? assigned[i] : real.id;
      if (!NO_ID.has(tab) && !effectiveId) noId++;
    }
    audit[tab] = { unknown: [...unknown], denied: [...denied], encrypted: [...encrypted], noId };
  }

  const report = {};
  if (COMMIT) {
    await sql.begin(async (tx) => {
      for (const [tab, { table, rows }] of Object.entries(source)) {
        report[tab] = await loadTable(tx, tab, table, rows, idPlan[tab].ids);
      }
      // Revisions restart at 1: clients re-baseline from this import's readAll,
      // and unlike ScriptProperties (apps-script-Code.gs:315) this value can
      // never be silently reseeded underneath them afterwards.
      await tx`update revs set rev = 1`;
    });

    if (BACKUP) {
      const map = { generatedAt: new Date().toISOString(), source: APPS_SCRIPT_URL, tabs: {} };
      for (const [tab, plan] of Object.entries(idPlan)) {
        if (plan.assignments.length) map.tabs[tab] = plan.assignments;
      }
      const dest = path.join(BACKUP, "id-map.json");
      fs.writeFileSync(dest, JSON.stringify(map, null, 2));
      console.log(`\nId mapping written to ${dest}`);
    }
  }

  let sourceTotal = 0, writtenTotal = 0;
  for (const [tab, { rows }] of Object.entries(source)) {
    const r = report[tab] ?? { written: 0, skipped: 0 };
    sourceTotal += rows.length;
    writtenTotal += r.written;
    console.log(
      tab.padEnd(16),
      String(rows.length).padStart(8),
      String(r.written).padStart(8),
      String(r.skipped).padStart(8),
      r.skipped ? "  <- rows with no id were skipped" : "",
    );
  }
  console.log("-".repeat(46));
  console.log("TOTAL".padEnd(16), String(sourceTotal).padStart(8), String(writtenTotal).padStart(8));

  // ── Transform audit ───────────────────────────────────────────────────────
  const missing = Object.entries(audit).filter(([, a]) => a.missingTable);
  if (missing.length) {
    console.error(`\nNO SUCH TABLE for: ${missing.map(([t]) => t).join(", ")}`);
    console.error("The schema in supabase/migrations is not applied, or is older than this script.");
    process.exitCode = 1;
  }

  const drift = Object.entries(audit).filter(([, a]) => a.unknown?.length);
  if (drift.length) {
    console.log("\nCOLUMNS NOT IN THE SCHEMA — these land in `extra` as JSON, not as real");
    console.log("columns. Harmless for data the app reads through extra; a bug if the sheet");
    console.log("gained a field the app now expects to query.");
    for (const [tab, a] of drift) console.log(`  ${tab.padEnd(16)} ${a.unknown.join(", ")}`);
  }

  const dropped = Object.entries(audit).filter(([, a]) => a.denied?.length);
  if (dropped.length) {
    console.log("\nDROPPED ON PURPOSE (deny-list — minimisation, not a bug):");
    for (const [tab, a] of dropped) console.log(`  ${tab.padEnd(16)} ${a.denied.join(", ")}`);
  }

  const enc = Object.entries(audit).filter(([, a]) => a.encrypted?.length);
  if (enc.length) {
    console.log("\nENCRYPTED AT REST (pgp_sym_encrypt, key from COUGAR_ENC_KEY):");
    for (const [tab, a] of enc) console.log(`  ${tab.padEnd(16)} ${a.encrypted.join(", ")}`);
  }

  const orphans = Object.entries(audit).filter(([, a]) => a.noId > 0);
  if (orphans.length) {
    console.log("\nROWS STILL WITH NO USABLE id — these would be SKIPPED, not imported.");
    console.log("Every id-bearing tab is keyed by assignIds, so this should be empty:");
    for (const [tab, a] of orphans) console.log(`  ${tab.padEnd(16)} ${a.noId} rows`);
    process.exitCode = 1;
  }

  if (COMMIT && sourceTotal !== writtenTotal) {
    console.error("\nMISMATCH: source and written row counts differ. Investigate before cutover.");
    process.exitCode = 1;
  }
} catch (e) {
  console.error("\nImport failed:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
