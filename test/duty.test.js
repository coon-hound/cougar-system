// The duty schedule: the promotion of STATE.duty from a per-device map to a
// synced tab, and the two off ledgers derived on top of it.
//
// The promotion is the risky half of this feature. STATE.duty used to be
// { "2026-09-15": { "CDO": "0001" } } in localStorage, and the parade state
// reads it through dutyForDate on every keystroke of the FP/LP modal. The
// shape underneath changed completely; the shape dutyForDate HANDS BACK did
// not, and that is what these pin.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

function load(seedLocal) {
  const store = new Map(Object.entries(seedLocal || {}));
  const sandbox = {
    console, Math, Date, JSON, String, Number, Array, Object, Boolean, RegExp,
    Set, Map, isNaN, parseInt, parseFloat,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    _store: store,
  };
  vm.createContext(sandbox);
  ["js/helpers.js", "js/state.js"].forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f }));
  // `const STATE` binds in the global LEXICAL environment, which is consulted
  // before the global object - so assigning sandbox.STATE would create a
  // second object that state.js never looks at. Hand out the real one by
  // reference instead, and mutate its properties.
  vm.runInContext("this.STATE = STATE;", sandbox);
  return sandbox;
}

const row = (date, role, slot, d4, status) => ({
  id: `duty-${date}-${role}${slot || ""}`, date, role, slot: slot || "",
  d4, status: status || "published", source: "manual", note: "",
});

module.exports = async function run() {

  suite("duty: dutyForDate keeps the shape the parade state expects");

  await test("rows come back keyed by role, with PDS carrying its platoon", () => {
    const s = load();
    s.STATE.duty = [
      row("2026-10-06", "CDO", "", "0001"),
      row("2026-10-06", "PDS", "7", "0004"),
    ];
    const d = s.dutyForDate("2026-10-06");
    eq(d.CDO, "0001", "a bare role keys by its own name");
    eq(d["PDS 7"], "0004", "PDS keys as 'PDS 7', exactly as paradeDutyRoles asks");
  });

  await test("an unrecorded date inherits the most recent EARLIER one, never a later one", () => {
    const s = load();
    s.STATE.duty = [row("2026-10-05", "CDO", "", "0001"), row("2026-10-20", "CDO", "", "0009")];
    // 10-05 is in the same month, so inheritance is off there - see below.
    // Use a date BEFORE any row to prove the backward direction is refused.
    eq(Object.keys(s.dutyForDate("2026-09-30")).length, 0,
      "a date before every row inherits nothing - tomorrow's plan must not rewrite yesterday");
  });

  await test("inheritance carries forward across a month boundary too", () => {
    const s = load();
    s.STATE.duty = [row("2026-09-15", "CDO", "", "0001")];
    eq(s.dutyForDate("2026-10-06").CDO, "0001", "the most recent earlier team is the starting point");
  });

  await test("the planner's read is literal, while the parade state's carries forward", () => {
    // The two reads answer different questions and must not be the same
    // function. Carry-forward is right for filing a parade state - most
    // appointments do carry over. It is wrong for COVERAGE: counting an
    // inherited team as a filled slot reports a month as covered when not one
    // row of it has been written, and the gap it hides is a duty nobody turns
    // up for.
    const s = load();
    s.STATE.duty = [row("2026-10-02", "CDO", "", "0009")];
    eq(s.dutyForDate("2026-10-20").CDO, "0009", "the parade state still carries the team forward");
    eq(Object.keys(s.dutyExactForDate("2026-10-20")).length, 0,
      "the planner sees an unwritten day as unwritten");
    eq(s.dutyExactForDate("2026-10-02").CDO, "0009", "and a written day as written");
  });

  await test("a draft never reaches a filed parade state unless asked for", () => {
    const s = load();
    s.STATE.duty = [row("2026-10-06", "CDO", "", "0009", "draft")];
    eq(Object.keys(s.dutyForDate("2026-10-06")).length, 0, "published-only by default");
    eq(s.dutyForDate("2026-10-06", { includeDraft: true }).CDO, "0009",
      "the planner opts in explicitly");
  });

  suite("duty: setDutyHolder");

  await test("editing one appointment materialises the five that were inherited", () => {
    // Otherwise changing the PDS on a carried-forward day silently drops the
    // CDO, CDS and COS that were only ever being inherited.
    const s = load();
    s.STATE.duty = [
      row("2026-09-15", "CDO", "", "0001"),
      row("2026-09-15", "CDS", "", "0002"),
    ];
    s.setDutyHolder("2026-10-06", "COS", "0003");
    const d = s.dutyForDate("2026-10-06");
    eq(d.COS, "0003", "the edit lands");
    eq(d.CDO, "0001", "the inherited CDO was written down rather than lost");
    eq(d.CDS, "0002", "and the inherited CDS with it");
  });

  await test("a blank d4 removes the row instead of storing an empty holder", () => {
    const s = load();
    s.STATE.duty = [row("2026-10-06", "CDO", "", "0001")];
    s.setDutyHolder("2026-10-06", "CDO", "");
    eq(s.STATE.duty.length, 0, "clearing a slot deletes the row");
  });

  await test("the id is the natural key, so two writes to one slot converge", () => {
    const s = load();
    s.setDutyHolder("2026-10-06", "PDS 7", "0004");
    s.setDutyHolder("2026-10-06", "PDS 7", "0005");
    eq(s.STATE.duty.length, 1, "one slot, one row - no unique index needed");
    eq(s.STATE.duty[0].d4, "0005", "last write wins");
    eq(s.STATE.duty[0].id, "duty-2026-10-06-PDS7", "and the id is derived, not minted");
  });

  suite("duty: promoting the old per-device map");

  await test("the localStorage command team is converted, not dropped", () => {
    const s = load({ "cougar-duty": JSON.stringify({
      "2026-09-15": { "CDO": "0001", "PDS 7": "0004" },
    }) });
    s.migrateLegacyDutyRoster();
    eq(s.STATE.duty.length, 2, "both appointments came across");
    const d = s.dutyForDate("2026-09-15");
    eq(d.CDO, "0001", "the CDO survived");
    eq(d["PDS 7"], "0004", "and the role key round-tripped through role+slot");
    eq(s.STATE.duty[0].status, "published", "these dates were filed, so they are published");
    eq(s.STATE.duty[0].source, "legacy", "and marked so the import can tell them apart");
  });

  await test("the server's copy wins, so two phones promoting the same day do not double it", () => {
    const s = load({ "cougar-duty": JSON.stringify({ "2026-09-15": { "CDO": "0001" } }) });
    s.STATE.duty = [row("2026-09-15", "CDO", "", "0009")];
    s.migrateLegacyDutyRoster();
    eq(s.STATE.duty.length, 1, "no duplicate row");
    eq(s.STATE.duty[0].d4, "0009", "the server's value is kept over this phone's");
  });

  await test("the old key is renamed, not deleted, and the migration is idempotent", () => {
    const s = load({ "cougar-duty": JSON.stringify({ "2026-09-15": { "CDO": "0001" } }) });
    s.migrateLegacyDutyRoster();
    eq(s.localStorage.getItem("cougar-duty"), null, "the old key is gone");
    ok(s.localStorage.getItem("cougar-duty-migrated-v1"), "but kept under a new name as the undo");
    s.migrateLegacyDutyRoster();
    eq(s.STATE.duty.length, 1, "a second run adds nothing");
  });

  await test("a corrupt or half-written map does not take the launch down", () => {
    const s = load({ "cougar-duty": "{not json" });
    s.migrateLegacyDutyRoster();
    eq(s.STATE.duty.length, 0, "nothing imported, nothing thrown");
    const s2 = load({ "cougar-duty": JSON.stringify({ "nonsense": { CDO: "0001" }, "2026-10-06": null }) });
    s2.migrateLegacyDutyRoster();
    eq(s2.STATE.duty.length, 0, "a non-ISO key and a null day are both skipped");
  });

  suite("duty: normalizeDuty");

  await test("the d4 is padded and the slot stays a string", () => {
    const s = load();
    const [r] = s.normalizeDuty([{ id: 1, date: "2026-10-06", role: "PDS", slot: 7, d4: 4 }]);
    eq(r.d4, "0004", "a commander 4D that lost its leading zeros in transit is repadded");
    eq(r.slot, "7", "a numeric slot becomes a string, or every === against the platoon is false");
    eq(typeof r.id, "string", "ids are TEXT");
  });

  await test("every row carries the full schema", () => {
    const s = load();
    const [r] = s.normalizeDuty([{ id: "x" }]);
    ["id", "date", "role", "d4", "slot", "status", "source", "note"]
      .forEach(k => ok(k in r, `${k} is present even on a sparse row`));
    eq(r.status, "published", "a missing status defaults to published, not blank");
  });

  suite("duty: the two off ledgers are derived, and kept apart");

  const withLedger = (extra) => {
    const s = load();
    s.STATE.roster = [{ id: "0001", name: "ALPHA ONE", role: "Commander", rank: "3SG",
                        appt: "VC", oilTracked: "true", leaveQuota: "14",
                        openingOilUsed: "2", openingAlUsed: "1", ...extra }];
    s.STATE.oilRule = [
      { id: "r1", event: "ARR", appliesTo: "ALL", days: "1" },
      { id: "r2", event: "PANZER", appliesTo: "VC", days: "4" },
      { id: "r3", event: "PANZER", appliesTo: "SC", days: "2" },
      { id: "r4", event: "ARMSKOTE", appliesTo: "0001", days: "0.5" },
    ];
    s.STATE.leave = [
      { id: "l1", d4: "0001", type: "Off-in-Lieu", days: "1" },
      { id: "l2", d4: "0001", type: "Annual Leave", days: "2" },
    ];
    return s;
  };

  await test("entitlement is the sum of the rules that apply, including a half day", () => {
    const s = withLedger();
    const b = s.commanderBalances("0001");
    eq(b.oil.entitled, 5.5, "ALL + his own VC rule + the rule naming him: 1 + 4 + 0.5");
    eq(b.oil.used, 3, "opening 2 plus one Off-in-Lieu day");
    eq(b.oil.remaining, 2.5, "and the balance is the difference, never a stored number");
  });

  await test("an SC does not collect the VC rule", () => {
    const s = withLedger({ appt: "SC" });
    eq(s.commanderBalances("0001").oil.entitled, 3.5, "1 + 2 + 0.5");
  });

  await test("a commander with no appointment collects neither class rule", () => {
    // The guard that matters: a blank appt must not match every VC and SC rule
    // at once just because "" is falsy on both sides.
    const s = withLedger({ appt: "" });
    eq(s.commanderBalances("0001").oil.entitled, 1.5, "only ALL and his own rule");
  });

  await test("annual leave never touches off-in-lieu", () => {
    const s = withLedger();
    const b = s.commanderBalances("0001");
    eq(b.al.entitled, 14, "the entitlement is the quota column");
    eq(b.al.used, 3, "opening 1 plus two days taken");
    eq(b.al.remaining, 11, "and it is a separate ledger from OIL");
  });

  await test("a BLANK quota reads as the default, not as no leave at all", () => {
    // +"" and +null are both 0, so an unfilled column would silently say this
    // man has no annual leave. Every live commander but one has it blank.
    const s = withLedger({ leaveQuota: "" });
    eq(s.commanderBalances("0001").al.entitled, 14, "blank falls back to 14");
    const s2 = withLedger({ leaveQuota: null });
    eq(s2.commanderBalances("0001").al.entitled, 14, "and so does a null");
    const s3 = withLedger({ leaveQuota: "7" });
    eq(s3.commanderBalances("0001").al.entitled, 7, "a real value is still honoured");
  });

  await test("a commander outside the off system returns null, not a row of zeros", () => {
    // Four of the twenty-four are in the schedule deliberately without a
    // ledger. Zeros would read as "he has taken everything".
    const s = withLedger({ oilTracked: "" });
    eq(s.commanderBalances("0001"), null, "untracked has no balance to show");
    eq(withLedger({ oilTracked: "false" }).commanderBalances("0001"), null,
      "and the string 'false' is not truthy here either, unlike every bare truthiness check");
  });

  await test("recruits and unknown ids have no balance", () => {
    const s = withLedger({ role: "Recruit" });
    eq(s.commanderBalances("0001"), null, "a recruit has no off ledger");
    eq(withLedger().commanderBalances("9999"), null, "nor does an id that is not on the roster");
  });

  suite("duty: who may hold which role");

  await test("CDS is the 2SGs, PDS is everyone else, and nobody does both", () => {
    const s = load();
    s.STATE.roster = [];
    const two = s.dutyEligibleRoles({ role: "Commander", rank: "2SG" });
    const three = s.dutyEligibleRoles({ role: "Commander", rank: "3SG" });
    ok(two.includes("CDS") && !two.includes("PDS"), "a 2SG takes CDS and not PDS");
    ok(three.includes("PDS") && !three.includes("CDS"), "a 3SG the other way round");
    eq(s.dutyEligibleRoles({ role: "Recruit" }).length, 0, "a recruit holds nothing");
  });
};
