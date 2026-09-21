// Tests for the departure planner (scripts/depart-plan.mjs).
//
// Posting a man out does two irreversible things at once: it archives every
// record he owns under a new key, and it hands his 4D to somebody else. Both
// ways of getting it wrong are silent.
//
//   * the wrong man resolved -> a serving recruit is archived and a departed
//     one keeps a live seat, and the app shows both as normal;
//   * a renumber that is not a clean permutation -> two roster rows collide on
//     the primary key mid-transaction, or a man's history detaches from him.
//
// So the cases below lean on the matcher, on the shape of the archive key
// (which is the only thing keeping two departures from the same seat apart),
// and on the renumber being reproducible - run it twice and the second run
// must be a no-op. Names here are invented; this repository is public.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const PLAN = pathToFileURL(path.join(ROOT, "scripts/depart-plan.mjs")).href;
const INTAKE = pathToFileURL(path.join(ROOT, "scripts/intake-plan.mjs")).href;

let P, I;
const load = async () => {
  P ??= await import(PLAN);
  I ??= await import(INTAKE);
};

// Platoon 5, section 1 deliberately NOT in alphabetical order: FOXTROT KOH
// sits below ECHO SIM's successor the way a hand-placed late arrival really
// does. A renumber has to fix that, not preserve it.
const ROSTER = [
  { id: "5101", name: "ALPHA TAN", role: "Recruit", pid: "P-ALPHA" },
  { id: "5102", name: "BRAVO LIM", role: "Recruit", pid: "P-BRAVO" },
  { id: "5103", name: "DELTA WONG", role: "Recruit", pid: "P-DELTA" },
  { id: "5104", name: "FOXTROT KOH", role: "Recruit", pid: "P-FOX" },
  { id: "5105", name: "ECHO SIM", role: "Recruit", pid: "P-ECHO" },
  { id: "5201", name: "CHARLIE NG", role: "Recruit", pid: "P-CHARLIE" },
  { id: "0028", name: "ZULU COMMANDER", role: "Commander", pid: "P-ZULU" },
];

const plan = (P, who, extra = {}) =>
  P.planDeparture({ roster: ROSTER, who, intake: "16", today: "2026-09-21", ...extra });

const moveMap = (p) => Object.fromEntries(p.moves.map((m) => [m.oldId, m.newId]));

async function main() {
  await load();

  suite("depart - the archive key");

  await test("carries the seat, the intake and the day", async () => {
    eq(P.departureKey("5104", "16", "2026-09-21"), "5104@16-out-20260921");
  });

  await test("a label with a slash stays one path-safe token", async () => {
    eq(P.departureKey("1101", "25/08", "2026-09-21"), "1101@25-08-out-20260921");
  });

  await test("padD4 passes an archive key through untouched", async () => {
    // The whole reason "@" is the separator: every read boundary in the app
    // re-pads the 4D, and a key padD4 mangled would stop matching its own
    // child rows.
    const key = P.departureKey("5104", "16", "2026-09-21");
    eq(I.padD4(key), key);
  });

  await test("the same seat vacated twice on one day does not collide", async () => {
    // A bare seat+intake key would. The man who moves up into 5104 today can
    // be posted out himself in November, and his history must not land on top
    // of this one's.
    const first = P.departureKey("5104", "16", "2026-09-21");
    const second = P.departureKey("5104", "16", "2026-09-21", [first]);
    ok(second !== first, "second departure got a distinct key");
    eq(second, "5104@16-out-20260921-2");
    eq(P.departureKey("5104", "16", "2026-09-21", [first, second]), "5104@16-out-20260921-3");
  });

  suite("depart - naming the man");

  await test("a 4D resolves him outright", async () => {
    const p = plan(P, "5104");
    ok(p.ok);
    eq(p.man.id, "5104");
    eq(p.archiveKey, "5104@16-out-20260921");
  });

  await test("an exact name resolves him too", async () => {
    const p = plan(P, "FOXTROT KOH");
    ok(p.ok);
    eq(p.man.id, "5104");
  });

  await test("a near miss is ranked and REFUSED, never accepted", async () => {
    const p = plan(P, "FOXTROT KO");
    ok(!p.ok, "a name that is nearly right must not post anybody out");
    ok(/nobody on the roster is named/.test(p.issues[0].message));
    ok(p.issues[0].candidates.length > 0, "the operator is given something to act on");
    eq(p.moves, []);
  });

  await test("an unknown 4D stops the run", async () => {
    const p = plan(P, "5999");
    ok(!p.ok);
    ok(/not an enlistee/.test(p.issues[0].message));
  });

  await test("--plt is a guard: a name that resolved into another platoon stops", async () => {
    const p = plan(P, "5104", { plt: "9" });
    ok(!p.ok);
    ok(/is in platoon 5, not 9/.test(p.issues[0].message));
    eq(p.moves, []);
  });

  await test("--plt agreeing with him is not an obstacle", async () => {
    ok(plan(P, "5104", { plt: "5" }).ok);
  });

  suite("depart - closing the hole");

  await test("the section is re-dealt alphabetically, not shifted up one", async () => {
    // ECHO belongs above FOXTROT, and FOXTROT is the man leaving. A positional
    // shift would leave ECHO at the bottom of the section forever.
    const p = plan(P, "5104");
    eq(moveMap(p), { 5105: "5104" });
    eq(p.unchanged.map((m) => m.oldId), ["5101", "5102", "5103"]);
  });

  await test("a man leaving the middle moves everyone below him", async () => {
    const p = plan(P, "5102");
    eq(moveMap(p), { 5103: "5102", 5105: "5103" });
    eq(p.unchanged.map((m) => m.oldId).sort(), ["5101", "5104"]);
  });

  await test("the departing man is never dealt a seat", async () => {
    for (const who of ["5101", "5102", "5103", "5104", "5105"]) {
      const p = plan(P, who);
      ok(p.ok, `${who} plans cleanly`);
      ok(p.moves.every((m) => m.oldId !== who), `${who} is not among the movers`);
      ok(!p.moves.concat(p.unchanged).some((m) => m.oldId === who), `${who} holds no seat after`);
    }
  });

  await test("the deal is a permutation - no two men get the same 4D", async () => {
    const p = plan(P, "5101");
    const seats = p.moves.concat(p.unchanged).map((m) => m.newId);
    eq(new Set(seats).size, seats.length);
    eq(seats.length, 4, "five men less the one leaving");
  });

  await test("running it again on the result is a no-op", async () => {
    // The property that makes alphabetical the right rule: the plan is
    // reproducible from the roster alone, so a half-finished run can be re-run.
    const first = plan(P, "5104");
    const after = ROSTER
      .filter((r) => r.id !== "5104")
      .map((r) => ({ ...r, id: moveMap(first)[r.id] ?? r.id }));
    const second = P.planDeparture({
      roster: after, who: "5201", intake: "16", today: "2026-09-21",
    });
    ok(second.ok);
    eq(second.moves, [], "section 1 is settled; only section 2 is touched");
  });

  await test("a man in the last seat costs nobody a renumber", async () => {
    const p = plan(P, "5105");
    ok(p.ok);
    eq(p.moves, []);
    eq(p.unchanged.length, 4);
  });

  await test("--keep-seat leaves the hole open", async () => {
    const p = plan(P, "5102", { renumber: false });
    ok(p.ok);
    eq(p.moves, []);
    eq(p.renumbered, false);
  });

  await test("only his own section is touched", async () => {
    const p = plan(P, "5102");
    ok(p.moves.concat(p.unchanged).every((m) => m.newId.slice(0, 2) === "51"),
      "section 2 is a different section and must not move");
  });

  suite("depart - a commander");

  await test("a commander can be posted out, and frees no seat", async () => {
    // 00xx is an administrative id, not a section seat. He is excluded from a
    // swap and a re-section for exactly that reason, and must NOT be excluded
    // from a departure - commanders get posted out more often than recruits.
    const p = plan(P, "0028");
    ok(p.ok, "he resolves");
    eq(p.man.id, "0028");
    eq(p.sect, "");
    eq(p.moves, []);
    eq(p.archiveKey, "0028@16-out-20260921");
  });

  await test("a commander is still not dealt into a section renumber", async () => {
    const p = plan(P, "5101");
    ok(p.moves.concat(p.unchanged).every((m) => m.oldId !== "0028"));
  });

  suite("depart - the report");

  await test("names are withheld unless asked for", async () => {
    // The report is the thing that gets pasted into a chat or a PR.
    const p = plan(P, "5104");
    const quiet = P.formatDepartReport(p);
    ok(!/FOXTROT/.test(quiet), "a report pasted into a chat must not carry names");
    ok(/READY/.test(quiet));
    ok(/5104@16-out-20260921/.test(quiet));
    ok(/FOXTROT/.test(P.formatDepartReport(p, { names: true })));
  });

  await test("a blocked plan says so and says nothing was written", async () => {
    const out = P.formatDepartReport(plan(P, "FOXTROT KO"));
    ok(/BLOCKED/.test(out));
    ok(/Nothing was written/.test(out));
    ok(!/READY/.test(out));
  });

  await test("what he carries is reported, including when it is nothing", async () => {
    const p = plan(P, "5104");
    ok(/medical 3, ippt 1/.test(P.formatDepartReport(p, { carries: { medical: 3, ippt: 1 } })));
    ok(/carries {6}nothing/.test(P.formatDepartReport(p, { carries: {} })));
  });
}

module.exports = main;
