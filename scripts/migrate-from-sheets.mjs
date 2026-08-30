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

const { APPS_SCRIPT_URL, COUGAR_AUTH, DATABASE_URL, COUGAR_ENC_KEY } = process.env;
const COMMIT = process.argv.includes("--commit");

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

async function api(action, tab) {
  const url = `${APPS_SCRIPT_URL}?action=${action}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}` +
              `&auth=${encodeURIComponent(COUGAR_AUTH)}`;
  const res = await fetch(url);
  const body = await res.json();
  if (body?.error) throw new Error(`${action}${tab ? ` ${tab}` : ""}: ${body.error}`);
  return body;
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

async function loadTable(sql, tab, table, rows) {
  const columns = await columnsOf(sql, table);
  let written = 0, skipped = 0;

  for (const raw of rows) {
    const { real, extra } = shape(tab, raw, columns);

    if (NO_ID.has(tab)) {
      const plain = {};
      for (const [k, v] of Object.entries(real)) plain[k] = v;
      const [ins] = await sql`insert into ${sql(table)} ${sql(plain)} returning _pk`;
      if (Object.keys(extra).length) {
        await sql`update ${sql(table)} set extra = ${sql.json(extra)} where _pk = ${ins._pk}`;
      }
      written++;
      continue;
    }

    const id = real.id;
    if (!id) { skipped++; continue; }

    // Insert-then-update keeps one encryption path, matching the Edge Function.
    await sql`
      insert into ${sql(table)} ("id") values (${id})
      on conflict ("id") do nothing`;

    const assign = Object.keys(real).map((k) =>
      ENCRYPTED.has(k)
        ? sql`${sql(k)} = enc_col(${real[k]}, ${COUGAR_ENC_KEY})`
        : sql`${sql(k)} = ${real[k]}`
    );
    await sql`
      update ${sql(table)}
         set ${assign.reduce((a, b) => sql`${a}, ${b}`)},
             extra = ${sql.json(extra)},
             deleted_at = null
       where "id" = ${id}`;
    written++;
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

  console.log("\n" + "tab".padEnd(16) + "source".padStart(8) +
              "written".padStart(9) + "skipped".padStart(9));
  console.log("-".repeat(46));

  const report = {};
  if (COMMIT) {
    await sql.begin(async (tx) => {
      for (const [tab, { table, rows }] of Object.entries(source)) {
        report[tab] = await loadTable(tx, tab, table, rows);
      }
      // Revisions restart at 1: clients re-baseline from this import's readAll,
      // and unlike ScriptProperties (apps-script-Code.gs:315) this value can
      // never be silently reseeded underneath them afterwards.
      await tx`update revs set rev = 1`;
    });
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
