// Unit tests for the read-boundary normalizers in js/state.js.
//
// These exist because of the Sheets → Postgres migration. The old backend
// returned real JS types: getValues() gave back a boolean for a checkbox cell,
// a number for a numeric one. Postgres stores every column as text (see
// 0001_init.sql on why), so the same field now arrives as "false" or "0" —
// strings, and every non-empty string is truthy.
//
// Anywhere the app reads a flag by plain truthiness, that difference silently
// inverts the meaning of the value. The normalizers are the one place that is
// fixed, so this is where it gets pinned.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

// Load the REAL state.js. It touches localStorage at module scope (the
// cougar-api-url override and the auth token), so it gets a stub; nothing here
// depends on what those return.
function loadState() {
  const store = new Map();
  const sandbox = {
    console, Math, Date, JSON, String, Number, Array, Object, Boolean, RegExp,
    Set, Map, isNaN, parseInt, parseFloat,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  vm.createContext(sandbox);
  // helpers.js loads first in index.html and the normalizers now call into it
  // (canonMedStatus), so load the same pair here.
  ["js/helpers.js", "js/state.js"].forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f }));
  return sandbox;
}

module.exports = async function run() {
  suite("normalizers: booleans survive a text-typed backend");

  await test("appointments: the string \"false\" does not read as resolved", () => {
    // THE bug this test exists for. `resolved` hides an appointment from the
    // dashboard and the parade state (js/render.js:907, js/forms.js:2235), and
    // both read it with plain `!a.resolved`. A text backend returns "false",
    // which is truthy — so every unresolved appointment would vanish from both
    // screens the moment the backend changed underneath the app.
    const { normalizeAppointments } = loadState();
    const [a] = normalizeAppointments([{ id: "a1", d4: "1101", resolved: "false", outOfCamp: "false" }]);
    eq(a.resolved, false, "resolved coerced to a real false");
    eq(a.outOfCamp, false, "outOfCamp coerced to a real false");
    ok(!a.resolved, "and therefore still shows on the dashboard");
  });

  await test("appointments: TRUE in any casing reads as true", () => {
    const { normalizeAppointments } = loadState();
    const rows = normalizeAppointments([
      { id: "a1", resolved: "TRUE", outOfCamp: "True" },
      { id: "a2", resolved: true, outOfCamp: true },
    ]);
    eq(rows.map((r) => r.resolved), [true, true], "resolved");
    eq(rows.map((r) => r.outOfCamp), [true, true], "outOfCamp");
  });

  await test("appointments: real booleans are untouched (Sheets is unaffected)", () => {
    // The normalizer ships before the cutover, so it has to be a no-op against
    // the backend that is still live.
    const { normalizeAppointments } = loadState();
    const rows = normalizeAppointments([
      { id: "a1", d4: "1101", resolved: false, outOfCamp: true },
      { id: "a2", d4: "0001", resolved: true, outOfCamp: false },
    ]);
    eq(rows.map((r) => [r.resolved, r.outOfCamp]), [[false, true], [true, false]]);
  });

  await test("appointments: d4 is padded like every other layer", () => {
    const { normalizeAppointments } = loadState();
    const [a] = normalizeAppointments([{ id: "a1", d4: "C7", resolved: false }]);
    eq(a.d4, "0007", "leading C stripped, padded to 4");
  });

  await test("appointments: a null row is passed through, not dereferenced", () => {
    const { normalizeAppointments } = loadState();
    eq(normalizeAppointments([null]), [null]);
    eq(normalizeAppointments(undefined), []);
  });

  suite("normalizers: the same coercion, already in place elsewhere");

  await test("roster outOfCamp / campIn take text or boolean", () => {
    // These two were already coerced (js/state.js:317-320) because Sheets could
    // hold either a checkbox or the literal text. Pinned here so the roster and
    // appointments paths cannot drift apart again.
    const { normalizeRoster } = loadState();
    const rows = normalizeRoster([
      { id: "1101", outOfCamp: "true", campIn: "TRUE" },
      { id: "1102", outOfCamp: true, campIn: false },
      { id: "1103", outOfCamp: "false", campIn: "" },
    ]);
    eq(rows.map((r) => r.outOfCamp), [true, true, false], "outOfCamp");
    eq(rows.map((r) => r.campIn), [true, false, false], "campIn");
  });

  await test("medical inCamp takes text or boolean", () => {
    const { normalizeMedical } = loadState();
    const rows = normalizeMedical([
      { id: "m1", d4: "1101", inCamp: "true" },
      { id: "m2", d4: "1102", inCamp: "TRUE" },
      { id: "m3", d4: "1103", inCamp: false },
      { id: "m4", d4: "1104", inCamp: "false" },
    ]);
    eq(rows.map((r) => r.inCamp), [true, true, false, false]);
  });

  await test("roster leaveQuota: empty stays empty, and never becomes 0", () => {
    // The other shape of the same problem: the guard at js/state.js:313 tests
    // `!== ""`, so a null would slip through and +null would make an unset
    // quota read as a quota of zero. api_row coalesces nulls to "" server-side
    // (0001_init.sql); this pins the client half of that contract.
    const { normalizeRoster } = loadState();
    const rows = normalizeRoster([
      { id: "1101", leaveQuota: "" },
      { id: "1102", leaveQuota: "14" },
      { id: "1103" },
    ]);
    eq(rows.map((r) => r.leaveQuota), ["", 14, ""]);
  });
  suite("normalizers: row ids are TEXT on every layer");

  // THE third migration bug, and the destructive one. Sheets typed the id column
  // as a NUMBER, so the forms could get away with `+gv("f-entry-id")` and compare
  // `row.id === editId`. Postgres types every column as text, so the same row
  // comes back as "1404" — `"1404" === 1404` is false, submitMedical falls
  // through its edit branch and APPENDS a duplicate instead of updating in place.
  // Verified against the real backend: one edit took Medical from 12 rows to 13.
  //
  // The fix is a single rule, pinned here for EVERY layer that carries an id:
  // ids are strings at the read boundary, so `===` is correct everywhere after.
  // A layer added later without routing through normId/padD4OnLayer fails here.
  const ID_LAYERS = [
    ["medical",       (S) => S.normalizeMedical],
    ["leave",         (S) => S.normalizeLeave],
    ["attendance",    (S) => S.normalizeAttendance],
    ["conductDetail", (S) => S.normalizeConductDetail],
    ["appointments",  (S) => S.normalizeAppointments],
    // ippt / rm / soc / polar / conducts have no normalizer of their own — they
    // go through padD4OnLayer directly (js/api.js PULL_ASSIGN, js/state.js
    // loadLocal), so that is what gets exercised for them.
    ["ippt",          (S) => S.padD4OnLayer],
    ["rm",            (S) => S.padD4OnLayer],
    ["soc",           (S) => S.padD4OnLayer],
    ["polar",         (S) => S.padD4OnLayer],
    ["conducts",      (S) => S.padD4OnLayer],
  ];

  for (const [layer, pick] of ID_LAYERS) {
    await test(`${layer}: a NUMBER id from the backend comes out a STRING`, () => {
      const S = loadState();
      const [row] = pick(S)([{ id: 1404, d4: "1101" }]);
      eq(row.id, "1404", "stringified, not left numeric");
      eq(typeof row.id, "string");
      // The comparison the forms actually make. `+"1404"` is a truthy 1404, so
      // a numeric id here would silently lose against the form's text value.
      ok(row.id === "1404", "strict-equal to the text id the form field holds");
      ok(row.id !== 1404, "and never strict-equal to the numeric form of it");
    });

    await test(`${layer}: a blank or null id becomes ""`, () => {
      const S = loadState();
      const rows = pick(S)([{ id: null, d4: "1101" }, { id: "", d4: "1102" }, { id: "  7001  ", d4: "1103" }]);
      eq(rows.map((r) => r.id), ["", "", "7001"], "null/blank normalise to \"\", and stray whitespace is trimmed");
    });
  }

  await test("a text id is passed through untouched (the post-cutover shape)", () => {
    const { normalizeMedical, padD4OnLayer } = loadState();
    eq(normalizeMedical([{ id: "1404" }])[0].id, "1404");
    // The current nextId() shape — base36 time + random, never numeric.
    eq(padD4OnLayer([{ id: "m9k2x1-4f7a2b" }])[0].id, "m9k2x1-4f7a2b");
  });

  suite("normalizers: roster ids stay padded 4D strings");

  await test("normalizeRoster derives id via padD4, not normId", () => {
    // Roster is the one layer whose id IS the 4D, so it keeps its own rule:
    // strip a leading C, pad 1-3 digits to 4. Stringifying it like the other
    // layers (String(1)) would give "1" and break every d4 join in the app.
    const { normalizeRoster } = loadState();
    const rows = normalizeRoster([
      { id: 1 }, { id: "1" }, { id: "C1101" }, { id: "c7" }, { id: "0001" }, { id: "1101" },
    ]);
    eq(rows.map((r) => r.id), ["0001", "0001", "1101", "0007", "0001", "1101"]);
    ok(rows.every((r) => typeof r.id === "string"), "always a string");
  });

  await test("a padded roster id auto-detects the commander role", () => {
    // Consequence of the padding: 00xx means Commander (js/state.js:305). If a
    // numeric 1 stayed "1" this would silently mis-role them.
    const { normalizeRoster } = loadState();
    eq(normalizeRoster([{ id: 1 }])[0].role, "Commander");
    eq(normalizeRoster([{ id: 1101 }])[0].role, "Recruit");
  });
};
