// Tests for the cutover acceptance gate (scripts/verify-migration.mjs).
//
// The gate exists to answer one question — "does the new backend serve what the
// old one served?" — and it used to be structurally incapable of noticing the
// single most dangerous way the answer is no.
//
// `id` is not a key in the source Sheet. 2,234 rows (every IPPT and PolarFlow
// row) have a blank id, and 16 rows share an id with a DIFFERENT record (11
// Medical, 5 Leave: id=1404 is both d4 4214's back pain AND d4 1311's fever).
// Postgres makes id a primary key, so importing drops the blank ones and
// collapses the duplicated pairs. The old gate joined both sides through
// `new Map(rows.map(r => [key(r), r]))`, which collapsed the BACKUP the same
// way the import collapsed the database, compared 1038 against 1038, found no
// difference, and printed "the new backend serves what the old one served" over
// 16 destroyed medical/leave records. Blank-id rows hit `if (!k) continue;` and
// vanished without a word.
//
// Every fixture below is shaped like the real data. `oldGateWouldPass` replays
// the exact broken join so the bug stays pinned: if someone reintroduces a
// last-write-wins Map, these tests go red.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const GATE = pathToFileURL(path.join(ROOT, "scripts/verify-migration.mjs")).href;

// The gate is ESM (it is a script, not app code), so it loads through import().
// It must not run its driver on import — that is what the `import.meta.url ===
// argv[1]` guard at the bottom of the file is for.
let gate;
async function loadGate() {
  if (!gate) gate = await import(GATE);
  return gate;
}

// The pre-fix comparison, verbatim in spirit: one Map per side keyed on id,
// blank keys skipped. Returns true when it would have called the tab clean.
function oldGateWouldPass(padD4, norm, oldRows, newRows, denied = new Set()) {
  const key = (r) => padD4(r.id ?? r["4d"] ?? "");
  const oldBy = new Map(oldRows.map((r) => [key(r), r]));
  const newBy = new Map(newRows.map((r) => [key(r), r]));
  for (const [k, o] of oldBy) {
    if (!k) continue;
    const n = newBy.get(k);
    if (!n) return false;
    for (const f of new Set([...Object.keys(o), ...Object.keys(n)])) {
      if (denied.has(f)) continue;
      const a = norm(f === "id" || f === "d4" ? padD4(o[f]) : o[f]);
      const b = norm(f === "id" || f === "d4" ? padD4(n[f]) : n[f]);
      if (a !== b) return false;
    }
  }
  for (const k of newBy.keys()) if (k && !oldBy.has(k)) return false;
  return true;
}

// (a) Two different people's Medical records sharing id=1404. A primary key on
//     id keeps one and destroys the other.
const COLLAPSED_OLD = [
  { id: "1404", d4: "4214", type: "MC", reason: "back pain", start: "2026-03-01", days: 2 },
  { id: "1404", d4: "1311", type: "MC", reason: "fever", start: "2026-05-09", days: 1 },
  { id: "1405", d4: "2201", type: "LD", reason: "ankle", start: "2026-05-10", days: 5 },
];
const COLLAPSED_NEW = [
  { id: "1404", d4: "1311", type: "MC", reason: "fever", start: "2026-05-09", days: "1" },
  { id: "1405", d4: "2201", type: "LD", reason: "ankle", start: "2026-05-10", days: "5" },
];

// (b) IPPT rows carry no id at all. The importer skips rows with no id, so they
//     simply never arrive.
const BLANK_OLD = [
  { id: "", d4: "1101", date: "2026-04-01", pushups: 40, situps: 42, run: "9:30", points: 75 },
  { id: "", d4: "1102", date: "2026-04-01", pushups: 35, situps: 38, run: "10:05", points: 68 },
  { id: "", d4: "1103", date: "2026-04-01", pushups: 50, situps: 51, run: "8:50", points: 90 },
];
const BLANK_NEW = [
  { id: "", d4: "1101", date: "2026-04-01", pushups: "40", situps: "42", run: "9:30", points: "75" },
  { id: "", d4: "1102", date: "2026-04-01", pushups: "35", situps: "38", run: "10:05", points: "68" },
];

// (c) A clean tab that exercises every deliberate difference at once: padded
//     ids, a "C" prefix, Sheets numbers vs Postgres text, real booleans vs
//     "false", and "" vs null.
const CLEAN_OLD = [
  { id: 1101, d4: 1101, name: "Tan", age: 20, smoker: true, gpa: 3.5, fieldOfStudy: "EE", nokOccupation: "teacher", notes: "" },
  { id: "C207", d4: "C207", name: "Lim", age: 21, smoker: false, gpa: 2.50, fieldOfStudy: "ME", nokOccupation: "", notes: "x" },
];
const CLEAN_NEW = [
  { id: "1101", d4: "1101", name: "Tan", age: "20", notes: null },
  { id: "207", d4: "207", name: "Lim", age: "21", notes: "x" },
];


// ---------------------------------------------------------------------------
// id-map fixtures. ids carry no meaning, so the importer may now assign new
// ones — but ONLY for a blank id or a collision, and only with a record of it
// in <backup>/id-map.json. The gate follows that record; it does not take the
// importer's word for anything else.
// ---------------------------------------------------------------------------

// Every IPPT row has a blank id, so every one of them gets an assignment.
const IPPT_OLD = [
  { id: "", d4: 1101, attempt: 1, date: "26 May 2026", pushups: 32, situps: 47, runTime: "26 Jan 1900", score: 75 },
  { id: "", d4: 1102, attempt: 1, date: "26 May 2026", pushups: 41, situps: 50, runTime: "26 Jan 1900", score: 82 },
  { id: "", d4: 1101, attempt: 2, date: "3 Aug 2026", pushups: 35, situps: 49, runTime: "26 Jan 1900", score: 79 },
];
const IPPT_ASSIGNED = ["a1b2c3d4e5f6", "b2c3d4e5f6a1", "c3d4e5f6a1b2"];
const IPPT_NEW = IPPT_OLD.map((r, i) => ({
  ...r, id: IPPT_ASSIGNED[i],
  d4: String(r.d4), attempt: String(r.attempt), pushups: String(r.pushups),
  situps: String(r.situps), score: String(r.score),
}));
const IPPT_MAP = IPPT_OLD.map((r, i) => ({
  rowIndex: i, oldId: "", newId: IPPT_ASSIGNED[i], key: { d4: String(r.d4), attempt: String(r.attempt) },
}));

// The Medical collision: two different people on id=1404. The FIRST occurrence
// keeps the original id; the second is the one that gets reassigned.
const MED_ASSIGNED = "9f8e7d6c5b4a";
const MED_MAP = [{ rowIndex: 1, oldId: "1404", newId: MED_ASSIGNED, key: { d4: "1311", date: "9 May 2026" } }];
const MED_NEW = [
  { id: "1404", d4: "4214", type: "MC", reason: "back pain", start: "2026-03-01", days: "2" },
  { id: MED_ASSIGNED, d4: "1311", type: "MC", reason: "fever", start: "2026-05-09", days: "1" },
  { id: "1405", d4: "2201", type: "LD", reason: "ankle", start: "2026-05-10", days: "5" },
];

module.exports = async function run() {
  suite("verify-migration: the gate can actually fail on id not being a key");

  const { compareTab, padD4, norm, DENY, NO_ID, NOT_MIGRATED } = await loadGate();

  await test("(a) a collapsed duplicate-id pair FAILS — the old gate passed it", () => {
    ok(oldGateWouldPass(padD4, norm, COLLAPSED_OLD, COLLAPSED_NEW),
       "pinned: the Map-keyed join saw nothing wrong with a destroyed record");

    const { problems } = compareTab("Medical", COLLAPSED_OLD, COLLAPSED_NEW);
    ok(problems.length, "the tab must fail");
    ok(problems.some((p) => /row count 3 → 2: 1 row\(s\) LOST/.test(p)), "raw counts are compared with no key involved");
    ok(problems.some((p) => /duplicate id in the BACKUP: 1 id\(s\) covering 2 rows/.test(p)), "the duplicate is named, with counts");
    ok(problems.some((p) => /1404×2/.test(p)), "the offending id is shown");
    ok(problems.some((p) => /id=1404 COLLAPSED: 2 distinct rows .* → 1/.test(p)), "the 2 → 1 collapse is reported per id");
  });

  await test("(b) a dropped blank-id row FAILS — the old gate passed it", () => {
    ok(oldGateWouldPass(padD4, norm, BLANK_OLD, BLANK_NEW),
       "pinned: `if (!k) continue` skipped all 2,234 blank-id rows in silence");

    const { problems, notes } = compareTab("IPPT", BLANK_OLD, BLANK_NEW);
    ok(problems.length, "the tab must fail");
    ok(problems.some((p) => /row count 3 → 2: 1 row\(s\) LOST/.test(p)), "raw counts catch it even with no key at all");
    ok(problems.some((p) => /1 blank-id row\(s\) in the backup are not in the new backend \(3 → 2\)/.test(p)),
       "blank-id loss is its own explicit problem");
    ok(notes.some((n) => /blank id: 3 row\(s\) in the backup, 2 in the new backend/.test(n)),
       "blank-key rows are counted out loud, never silently skipped");
  });

  await test("(c) a clean tab PASSES, with every deliberate difference still exempt", () => {
    const { problems, notes, comparedRows } = compareTab("Roster", CLEAN_OLD, CLEAN_NEW);
    eq(problems, [], "padD4, the Roster deny-list, text-vs-number and \"\"-vs-null must not raise a diff");
    eq(notes, [], "nothing to note on a clean keyed tab");
    eq(comparedRows, 2, "both rows were actually compared, not skipped");
  });

  await test("blank-id rows that all survive are noted but do not fail", () => {
    const { problems, notes } = compareTab("IPPT", BLANK_OLD, BLANK_OLD.map((r) => ({ ...r, pushups: String(r.pushups) })));
    eq(problems, [], "same count in and out is not loss");
    ok(notes.some((n) => /blank id: 3 row\(s\) in the backup, 3 in the new backend/.test(n)), "still reported");
  });

  await test("duplicate ids on the NEW side are reported too", () => {
    const oldRows = [{ id: "1", d4: "1101" }, { id: "2", d4: "1102" }];
    const newRows = [{ id: "1", d4: "1101" }, { id: "1", d4: "1101" }, { id: "2", d4: "1102" }];
    const { problems } = compareTab("Leave", oldRows, newRows);
    ok(problems.some((p) => /duplicate id in the NEW backend: 1 id\(s\) covering 2 rows/.test(p)), "named with counts");
    ok(problems.some((p) => /1 unexplained extra row/.test(p)), "and the raw count surplus");
  });

  await test("a surviving duplicate pair on both sides is compared row for row", () => {
    const newRows = [
      { id: "1404", d4: "4214", type: "MC", reason: "back pain", start: "2026-03-01", days: "2" },
      { id: "1404", d4: "1311", type: "MC", reason: "fever", start: "2026-05-09", days: "1" },
      { id: "1405", d4: "2201", type: "LD", reason: "ankle", start: "2026-05-10", days: "5" },
    ];
    const clean = compareTab("Medical", COLLAPSED_OLD, newRows);
    // The duplicate id is still called out — id is not a key, and a human has to
    // know that — but nothing is reported as lost or different.
    ok(clean.problems.every((p) => /duplicate id in the (BACKUP|NEW backend)/.test(p)), "no loss reported when both rows survived");
    eq(clean.problems.length, 2, "just the two duplicate-key notices, one per side");
    eq(clean.comparedRows, 3, "all three rows compared, none overwritten");

    // Swap the second duplicate's reason: the field diff must still reach it.
    const tampered = newRows.map((r, i) => (i === 1 ? { ...r, reason: "flu" } : r));
    const { problems } = compareTab("Medical", COLLAPSED_OLD, tampered);
    ok(problems.some((p) => /id=1404\[1\] reason differs/.test(p)), "the duplicate's second row is diffed, not shadowed");
  });

  await test("missing and extra keyed rows still fail, with duplicate counts", () => {
    const oldRows = [{ id: "1", d4: "1101" }, { id: "2", d4: "1102" }, { id: "2", d4: "1103" }];
    const newRows = [{ id: "1", d4: "1101" }, { id: "9", d4: "1109" }];
    const { problems } = compareTab("Leave", oldRows, newRows);
    ok(problems.some((p) => /missing row id=0002 \(2 rows\)/.test(p)), "a missing key takes its whole group with it");
    ok(problems.some((p) => /extra row id=0009/.test(p)), "extras still reported");
  });

  await test("NO_ID tabs are compared by raw count alone", () => {
    ok(NO_ID.has("MSK") && NO_ID.has("Config"), "MSK and Config have no id to join on");
    const rows = [{ a: 1 }, { a: 2 }];
    eq(compareTab("MSK", rows, rows).problems, [], "equal counts pass");
    const { problems } = compareTab("MSK", rows, [{ a: 1 }]);
    ok(problems.some((p) => /row count 2 → 1: 1 row\(s\) LOST/.test(p)), "a shortfall fails");
  });

  await test("values stay withheld unless --show-values is passed", () => {
    const oldRows = [{ id: "1", d4: "1101", reason: "chest infection" }];
    const newRows = [{ id: "1", d4: "1101", reason: "flu" }];

    const quiet = compareTab("Medical", oldRows, newRows).problems.join(" ");
    ok(!/chest infection|flu/.test(quiet), "real personnel data must not land in a terminal log by default");
    eq(compareTab("Medical", oldRows, newRows).problems, ["id=0001 reason differs"]);

    const loud = compareTab("Medical", oldRows, newRows, { showValues: true }).problems.join(" ");
    ok(/chest infection/.test(loud) && /flu/.test(loud), "--show-values still shows both sides");
  });

  await test("the deliberate-difference exemptions are exactly the documented ones", () => {
    eq([...DENY.Roster].sort(), ["fieldOfStudy", "gpa", "nokOccupation", "smoker"]);
    eq([...NOT_MIGRATED].sort(), ["Conduct Master", "Sheet3", "notes"]);
    eq(norm(14), norm("14.0"), "Sheets number vs Postgres text");
    eq(norm(2.50), norm("2.5"));
    eq(norm(true), "true");
    eq(norm(false), norm("false"), "a real boolean and the text one match");
    eq(norm(null), norm(""), "\"\" and null both read as empty");
    eq(norm(undefined), "");
    eq(padD4(1101), "1101");
    eq(padD4("C207"), "0207");
    eq(padD4(" 7 "), "0007");
  });

  suite("verify-migration: the id-map lets a reassigned row be followed, not excused");

  const { loadIdMap, parseIdMap, validateMapping, ID_MAP_FILE } = await loadGate();

  // Writes a throwaway backup dir so loadIdMap's real file I/O is exercised.
  function tmpBackup(idMapContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cougar-idmap-"));
    if (idMapContent !== undefined) {
      fs.writeFileSync(path.join(dir, ID_MAP_FILE),
        typeof idMapContent === "string" ? idMapContent : JSON.stringify(idMapContent));
    }
    return dir;
  }

  await test("(m1) a clean mapped tab PASSES, and says how each row was matched", () => {
    const { problems, comparedRows, matched } = compareTab("IPPT", IPPT_OLD, IPPT_NEW, { mapping: IPPT_MAP });
    eq(problems, [], "a recorded id assignment is not a difference");
    eq(comparedRows, 3, "every row was still compared field by field");
    eq(matched, { preserved: 0, mapped: 3, failed: 0 }, "all three matched through the mapping");

    // The collision case: first occurrence keeps its id, second is reassigned.
    const med = compareTab("Medical", COLLAPSED_OLD, MED_NEW, { mapping: MED_MAP });
    eq(med.problems, [], "the reassigned duplicate is followed to its new id, and nothing is lost");
    eq(med.matched, { preserved: 2, mapped: 1, failed: 0 }, "2 by preserved id, 1 via the map");
    ok(med.notes.some((n) => /the backup itself has 1 duplicated id\(s\) covering 2 rows/.test(n)),
       "the source collision is still reported, so a human knows the importer intervened");
  });

  await test("(m2) a blank-id row the mapping MISSES still fails", () => {
    const partial = IPPT_MAP.slice(0, 2);              // rowIndex 2 left behind
    const newRows = [IPPT_NEW[0], IPPT_NEW[1], { ...IPPT_NEW[2], id: "" }];
    const { problems, notes, matched } = compareTab("IPPT", IPPT_OLD, newRows, { mapping: partial });
    ok(problems.some((p) => /1 blank-id row\(s\) in the backup are NOT accounted for by the id-map/.test(p)),
       "an unmapped blank id cannot survive a primary key, mapping present or not");
    ok(notes.some((n) => /blank id: 1 row\(s\) in the backup/.test(n)), "and the count is still reported");
    eq(matched.failed, 1, "counted as a failure, not quietly matched");
  });

  await test("(m3) a mapping that reuses a newId FAILS loudly", () => {
    const dup = IPPT_MAP.map((e, i) => (i === 2 ? { ...e, newId: IPPT_ASSIGNED[0] } : e));
    const { problems } = compareTab("IPPT", IPPT_OLD, IPPT_NEW, { mapping: dup });
    ok(problems.some((p) => /assigns newId=a1b2c3d4e5f6 to both rowIndex=0 and rowIndex=2/.test(p)),
       "a reused newId collapses two records into one");
    ok(problems.some((p) => /is not sound — refusing to join through it/.test(p)),
       "and the gate refuses to join through it rather than reporting a confusing diff");
  });

  await test("(m4) a mapped row whose OTHER fields changed still FAILS", () => {
    const tampered = IPPT_NEW.map((r, i) => (i === 1 ? { ...r, situps: "12" } : r));
    const { problems, matched } = compareTab("IPPT", IPPT_OLD, tampered, { mapping: IPPT_MAP });
    ok(problems.some((p) => /situps differs/.test(p)), "only `id` is exempt for a mapped row; every other field is diffed");
    ok(!problems.some((p) => /\bid differs/.test(p)), "the recorded id change itself is not reported as a diff");
    eq(matched, { preserved: 0, mapped: 2, failed: 1 }, "the bad row counts as failed, the others as mapped");
  });

  await test("(m5) a newId colliding with a PRESERVED id in the same tab FAILS", () => {
    const collide = [{ rowIndex: 1, oldId: "1404", newId: "1405", key: { d4: "1311" } }];
    const { problems } = compareTab("Medical", COLLAPSED_OLD, MED_NEW, { mapping: collide });
    ok(problems.some((p) => /PRESERVES that same id/.test(p)), "assigning an id another row kept just moves the collision");
  });

  await test("(m6) a mapping that does not describe this backup FAILS", () => {
    const stale = [{ rowIndex: 99, oldId: "", newId: "deadbeef" }];
    const off = compareTab("IPPT", IPPT_OLD, IPPT_NEW, { mapping: stale }).problems;
    ok(off.some((p) => /no such row in the backup \(tab has 3 row\(s\)\)/.test(p)), "every mapped rowIndex must exist");

    const wrongOld = [{ rowIndex: 0, oldId: "1404", newId: "deadbeef" }];
    const bad = compareTab("IPPT", IPPT_OLD, IPPT_NEW, { mapping: wrongOld }).problems;
    ok(bad.some((p) => /mapping says oldId was/.test(p)), "and must agree with the backup about what it renamed");

    const twice = [
      { rowIndex: 0, oldId: "", newId: "aaaa1111" },
      { rowIndex: 0, oldId: "", newId: "bbbb2222" },
    ];
    ok(validateMapping("IPPT", twice, IPPT_OLD).some((p) => /mapped twice/.test(p)), "one row, one assignment");
  });

  await test("(m7) raw row counts stay absolute — the mapping cannot excuse a lost row", () => {
    const short = IPPT_NEW.slice(0, 2);
    const { problems } = compareTab("IPPT", IPPT_OLD, short, { mapping: IPPT_MAP });
    ok(problems.some((p) => /row count 3 → 2: 1 row\(s\) LOST/.test(p)), "875 in must be 875 out, mapping or no mapping");
  });

  await test("(m8) with NO id-map.json the gate behaves exactly as before", () => {
    const dir = tmpBackup(undefined);
    eq(loadIdMap(dir), null, "an unmapped backup is a valid input, not an error");

    // Same fixtures, no mapping: the pre-existing failures must all come back.
    const { problems } = compareTab("IPPT", IPPT_OLD, IPPT_NEW);
    ok(problems.some((p) => /blank id/.test(p)) || problems.some((p) => /extra row id=/.test(p)),
       "unexplained new ids are still unexplained without a mapping");
    eq(compareTab("Roster", CLEAN_OLD, CLEAN_NEW).problems, [], "and a clean unmapped tab still passes");
    eq(compareTab("Medical", COLLAPSED_OLD, COLLAPSED_NEW).problems.length > 0, true, "the old failures are untouched");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("(m9) an id-map.json that exists but is unusable FAILS loudly, never as 'no mapping'", () => {
    const attempts = [
      ["not json at all", "not valid JSON"],
      [{ generatedAt: "x" }, "expected a `tabs` object"],
      [{ tabs: { IPPT: {} } }, "must be an array of entries"],
      [{ tabs: { IPPT: [{ oldId: "", newId: "a1" }] } }, "rowIndex must be a non-negative integer"],
      [{ tabs: { IPPT: [{ rowIndex: 0, oldId: "", newId: "" }] } }, "newId must be a non-empty string"],
      [{ tabs: { IPPT: [{ rowIndex: 0, newId: "a1" }] } }, "missing oldId"],
    ];
    for (const [content, expected] of attempts) {
      const dir = tmpBackup(content);
      let msg = "";
      try { loadIdMap(dir); } catch (e) { msg = e.message; }
      ok(msg.includes(expected), `expected a message about "${expected}", got ${JSON.stringify(msg)}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("(m10) a well-formed id-map.json round-trips off disk", () => {
    const dir = tmpBackup({ generatedAt: "2026-09-13T12:54:16Z", tabs: { IPPT: IPPT_MAP, Medical: MED_MAP } });
    const map = loadIdMap(dir);
    eq(map.generatedAt, "2026-09-13T12:54:16Z");
    eq(map.tabs.get("IPPT").length, 3);
    eq(map.tabs.get("Medical")[0].newId, MED_ASSIGNED);
    eq(map.tabs.get("Nope"), undefined, "a tab with no assignments simply has no entry");
    eq(compareTab("IPPT", IPPT_OLD, IPPT_NEW, { mapping: map.tabs.get("IPPT") }).problems, [],
       "the mapping read off disk is the one the comparison uses");
    eq(parseIdMap({ tabs: {} }).tabs.size, 0, "an empty mapping is well-formed");
    fs.rmSync(dir, { recursive: true, force: true });
  });
};
