// Tests for the company-wide promotion planner (scripts/promote-plan.mjs).
//
// `role` and `rank` are different fields and only one of them moves. The two
// ways of getting this wrong are both silent:
//
//   * a commander caught by the filter is DEMOTED on every surface that prints
//     a rank, and the app agrees with itself, so nobody notices from inside it;
//   * a run that is not idempotent turns a repeat into a second set of writes
//     over rows that were already correct.
//
// So the cases below are weighted towards the Commander exclusion and towards
// running the same plan twice. Names here are invented - this repository is
// public.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const PLAN = pathToFileURL(path.join(ROOT, "scripts/promote-plan.mjs")).href;

let P;
const load = async () => (P ??= await import(PLAN));

// A blank rank, a literal REC, an already-promoted PTE and a commander: the
// four shapes a real roster carries the morning of a posting.
const ROSTER = [
  { id: "7101", name: "ALPHA TAN", role: "Recruit", rank: "", pid: "P-ALPHA" },
  { id: "7102", name: "BRAVO LIM", role: "Recruit", rank: "REC", pid: "P-BRAVO" },
  { id: "8101", name: "CHARLIE NG", role: "Recruit", rank: "rec", pid: "P-CHARLIE" },
  { id: "9101", name: "DELTA WONG", role: "Recruit", rank: "PTE", pid: "P-DELTA" },
  { id: "0001", name: "ZULU COMMANDER", role: "Commander", rank: "3SG", pid: "P-ZULU" },
];

const ids = (rows) => rows.map((r) => r.id);

async function main() {
  const P = await load();
  const plan = (o = {}) => P.planPromotion({ roster: ROSTER, ...o });

  suite("promote - who moves and who does not");

  await test("every enlistee that is blank or REC is promoted", () => {
    const p = plan();
    ok(p.ok, "a clean roster must plan without issues");
    eq(ids(p.promote), ["7101", "7102", "8101"]);
    eq(p.rank, "PTE");
  });

  await test("a lowercase rank in the column is still a REC row", () => {
    // The column is free text and has been typed by hand. "rec" is REC.
    const p = plan();
    ok(ids(p.promote).includes("8101"), "a lowercase rec must be recognised");
  });

  await test("a blank rank is reported as blank, not as REC", () => {
    const from = plan().promote.find((m) => m.id === "7101").from;
    eq(from, "", "the report has to distinguish an empty column from a typed REC");
  });

  suite("promote - a commander is never touched");

  await test("the commander is excluded and counted, never promoted", () => {
    const p = plan();
    eq(ids(p.commanders), ["0001"]);
    ok(!ids(p.promote).includes("0001"), "a 3SG rewritten to PTE is a demotion");
  });

  await test("the exclusion is on role, not on rank", () => {
    // Scoping on rank to decide role is the exact confusion this repository
    // warns about: a commander whose rank column is blank is still a commander,
    // and a blank rank is otherwise the main thing that gets promoted.
    const p = P.planPromotion({ roster: [{ id: "0002", name: "ZULU COMMANDER", role: "Commander", rank: "" }] });
    eq(p.promote, []);
    eq(ids(p.commanders), ["0002"]);
  });

  await test("role matching tolerates case and whitespace", () => {
    const p = P.planPromotion({ roster: [{ id: "0003", name: "ZULU COMMANDER", role: " commander ", rank: "" }] });
    eq(p.promote, []);
  });

  suite("promote - idempotence");

  await test("a row already at the target rank is not a write", () => {
    const p = plan();
    eq(ids(p.already), ["9101"]);
    ok(!ids(p.promote).includes("9101"));
  });

  await test("running it twice changes nothing the second time", () => {
    // What the apply leaves behind, fed back in: the real second run.
    const after = ROSTER.map((r) => (r.role === "Commander" ? r : { ...r, rank: "PTE" }));
    const p = P.planPromotion({ roster: after });
    ok(p.ok, "a second run must not block");
    eq(p.promote, []);
    eq(p.already.length, 4);
    ok(/nothing to do/i.test(P.formatPromotionReport(p)), "the report has to say so plainly");
  });

  suite("promote - refusing a demotion");

  await test("an enlistee already holding another rank blocks the run", () => {
    const p = P.planPromotion({ roster: [...ROSTER, { id: "7103", name: "ECHO SIM", role: "Recruit", rank: "CPL" }] });
    ok(!p.ok, "writing PTE over a CPL is a demotion and must not run silently");
    eq(ids(p.blocked), ["7103"]);
    eq(p.promote, [], "nothing at all is planned while the run is blocked");
    ok(/--force/.test(P.formatPromotionReport(p)), "the report must name the way through");
  });

  await test("a whole cohort in the blocked list is capped, not dumped", () => {
    // Target a rank the company has already passed and every man blocks at
    // once. A hundred 4Ds printed twice is a report an operator scrolls past.
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `03${String(i + 1).padStart(2, "0")}`, name: "ALPHA TAN", role: "Recruit", rank: "PTE",
    }));
    const txt = P.formatPromotionReport(P.planPromotion({ roster: many, rank: "LCP" }));
    ok(/and 33 more/.test(txt), "the list has to be capped: " + txt);
    ok(!/Forced past/.test(txt), "an unforced run must not print the same ids twice: " + txt);
  });

  await test("--force takes those rows too, deliberately", () => {
    const p = P.planPromotion({
      roster: [...ROSTER, { id: "7103", name: "ECHO SIM", role: "Recruit", rank: "CPL" }],
      force: true,
    });
    ok(p.ok);
    ok(ids(p.promote).includes("7103"));
  });

  await test("an unknown target rank is refused outright", () => {
    const p = plan({ rank: "PTX" });
    ok(!p.ok);
    eq(p.promote, []);
  });

  await test("another legal rank can be targeted", () => {
    const p = plan({ rank: "lcp" });
    eq(p.rank, "LCP", "the target is normalised, so --rank lcp is --rank LCP");
    // The already-PTE man is now a row holding some other rank, so he blocks.
    // That is right: LCP over PTE is a promotion, but this tool cannot know
    // which direction any pair of ranks runs in, and the operator passing
    // --force is what turns it into a decision rather than a guess.
    ok(!p.ok);
    eq(ids(p.blocked), ["9101"]);
    ok(ids(plan({ rank: "lcp", force: true }).promote).includes("7101"));
  });

  suite("promote - the report");

  await test("the report never prints names unless asked", () => {
    const p = plan();
    const quiet = P.formatPromotionReport(p);
    ok(!/BRAVO/.test(quiet), "a report pasted into a chat must not carry names");
    ok(/READY/.test(quiet));
    ok(/1 commander\(s\)/.test(quiet), "the operator has to see the commanders were counted and skipped");
    ok(/BRAVO/.test(P.formatPromotionReport(p, { names: true })));
  });
}

module.exports = main;
