// Tests for the re-section planner (scripts/reseat-plan.mjs).
//
// Re-sectioning a platoon re-keys a primary key across a set that overlaps
// itself, and every child table joins on that key. Both ways of getting it
// wrong are silent:
//
//   * a man matched to the wrong roster row inherits a stranger's medical
//     history, and nothing downstream will ever flag it;
//   * a man left off the list keeps a seat in a section that no longer exists.
//
// So the cases below are weighted towards the matcher and the closed-set check,
// which is the property that makes the rest safe. Names here are invented —
// this repository is public.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const PLAN = pathToFileURL(path.join(ROOT, "scripts/reseat-plan.mjs")).href;

let P;
const load = async () => (P ??= await import(PLAN));

// Platoon 5, two sections, alphabetical within each — how the roster is
// always numbered, and what the planner has to reproduce.
const ROSTER = [
  { id: "5101", name: "ALPHA TAN", role: "Recruit", pid: "P-ALPHA" },
  { id: "5102", name: "BRAVO LIM", role: "Recruit", pid: "P-BRAVO" },
  { id: "5103", name: "CHARLIE NG", role: "Recruit", pid: "P-CHARLIE" },
  { id: "5201", name: "DELTA WONG", role: "Recruit", pid: "P-DELTA" },
  { id: "5202", name: "ECHO SIM", role: "Recruit", pid: "P-ECHO" },
];

const plan = (P, text, roster = ROSTER, plt = 5) =>
  P.planReseat({ plt, roster, sections: P.parseSections(text).sections });

const moveMap = (p) => Object.fromEntries(p.moves.map((m) => [m.oldId, m.newId]));

async function main() {
  const P = await load();

  suite("reseat — parsing the operator's list");

  await test("reads the pasted format: em dashes, emoji, counts", async () => {
    const { sections, issues } = P.parseSections(
      "SECTION 1 — 2\nALPHA TAN — 🔵 Hunter Driver\nCHARLIE NG — 🟢 AI\n\nSECTION 2 — 1\nDELTA WONG — 🔴 Gunner\n",
    );
    eq(issues, []);
    eq(sections.map((s) => s.sect), [1, 2]);
    eq(sections[0].members.map((m) => m.name), ["ALPHA TAN", "CHARLIE NG"]);
    eq(sections[1].members.map((m) => m.name), ["DELTA WONG"]);
  });

  await test("a hyphen inside a name is not a field separator", async () => {
    // Splitting on "-" instead of the em dash truncates "NUR-AQIF" to "NUR".
    const { sections } = P.parseSections("SECTION 1 — 1\nNUR-AQIF BIN AMRAN — 🟢 AI\n");
    eq(sections[0].members[0].name, "NUR-AQIF BIN AMRAN");
  });

  await test("a comma is punctuation, not a separator", async () => {
    const { sections } = P.parseSections("SECTION 1 — 1\nHO SAM HIN, JAYDEN — 🟢 AI\n");
    eq(sections[0].members[0].name, "HO SAM HIN JAYDEN");
  });

  await test("tolerates a missing space before the dash and trailing spaces", async () => {
    const { sections } = P.parseSections("SECTION 1 — 2\nLESTER LIM— 🟢 AI\nALPHA TAN  — 🔴 Gunner\n");
    eq(sections[0].members.map((m) => m.name), ["LESTER LIM", "ALPHA TAN"]);
  });

  await test("a trailing [4D] pins the line and is stripped from the name", async () => {
    const { sections } = P.parseSections("SECTION 1 — 1\nALFA TAN [5101] — 🟢 AI\n");
    eq(sections[0].members[0], { name: "ALFA TAN", pin: "5101", line: 2 });
  });

  await test("a name before any SECTION header is an error, not a silent drop", async () => {
    const { issues } = P.parseSections("ALPHA TAN — 🟢 AI\nSECTION 1 — 0\n");
    eq(issues.length, 1);
    ok(/before any SECTION/.test(issues[0].message));
  });

  suite("reseat — dealing the seats");

  await test("sequence within a section is alphabetical, not the listed order", async () => {
    // Listed in appointment order (gunner first). The plan must ignore that.
    const p = plan(P,
      "SECTION 1 — 3\nCHARLIE NG — 🔴 Gunner\nBRAVO LIM — 🟢 AI\nALPHA TAN — 🟢 AI\n" +
      "SECTION 2 — 2\nECHO SIM — 🔵 Hunter Driver\nDELTA WONG — 🟢 AI\n");
    ok(p.ok, JSON.stringify(p.issues));
    eq(p.sections[0].rows.map((r) => `${r.newId}`), ["5101", "5102", "5103"]);
    eq(p.moves, []);
    eq(p.unchanged.length, 5, "a list that only reorders within sections changes nothing");
  });

  await test("a section whose membership is unchanged keeps its numbers", async () => {
    const p = plan(P,
      "SECTION 1 — 2\nCHARLIE NG — 🟢 AI\nALPHA TAN — 🟢 AI\n" +
      "SECTION 2 — 3\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\nBRAVO LIM — 🟢 AI\n");
    ok(p.ok, JSON.stringify(p.issues));
    // Section 1 loses BRAVO, so CHARLIE closes up behind ALPHA; section 2 gains
    // him at the front alphabetically and everyone behind shifts one.
    eq(moveMap(p), { "5103": "5102", "5102": "5201", "5201": "5202", "5202": "5203" });
    eq(p.unchanged.map((u) => u.oldId), ["5101"]);
  });

  await test("every dealt 4D is unique and well formed", async () => {
    const p = plan(P,
      "SECTION 1 — 1\nECHO SIM — 🟢 AI\n" +
      "SECTION 2 — 4\nALPHA TAN — 🟢 AI\nBRAVO LIM — 🟢 AI\nCHARLIE NG — 🟢 AI\nDELTA WONG — 🟢 AI\n");
    ok(p.ok, JSON.stringify(p.issues));
    const ids = [...p.moves, ...p.unchanged].map((r) => r.newId);
    eq(ids.length, 5);
    eq(new Set(ids).size, 5, "no two men may be dealt the same seat");
    ok(ids.every((i) => /^5[12]\d{2}$/.test(i)), ids.join(","));
  });

  await test("commanders hold no section seat and are left out", async () => {
    const roster = [...ROSTER, { id: "0012", name: "ZULU COMMANDER", role: "Commander", pid: "P-Z" }];
    const p = plan(P,
      "SECTION 1 — 3\nALPHA TAN — 🟢 AI\nBRAVO LIM — 🟢 AI\nCHARLIE NG — 🟢 AI\n" +
      "SECTION 2 — 2\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\n", roster);
    ok(p.ok, JSON.stringify(p.issues));
    eq([...p.moves, ...p.unchanged].length, 5);
  });

  await test("men from another platoon are untouched", async () => {
    const roster = [...ROSTER, { id: "7101", name: "FOXTROT KOH", role: "Recruit", pid: "P-F" }];
    const p = plan(P,
      "SECTION 1 — 3\nALPHA TAN — 🟢 AI\nBRAVO LIM — 🟢 AI\nCHARLIE NG — 🟢 AI\n" +
      "SECTION 2 — 2\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\n", roster);
    ok(p.ok, JSON.stringify(p.issues));
    ok(![...p.moves, ...p.unchanged].some((r) => r.oldId === "7101"));
  });

  suite("reseat — what it refuses to guess at");

  await test("a name that is not on the roster BLOCKS and names its candidates", async () => {
    // One character out. A looser matcher would take it; this one must not,
    // because the same looseness is what merges two different men.
    const p = plan(P,
      "SECTION 1 — 3\nALFA TAN — 🟢 AI\nBRAVO LIM — 🟢 AI\nCHARLIE NG — 🟢 AI\n" +
      "SECTION 2 — 2\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\n");
    ok(!p.ok);
    eq(p.moves, []);
    const e = p.issues.find((i) => /no recruit/.test(i.message));
    ok(e, "expected an unmatched-name issue");
    eq(e.candidates[0].id, "5101", "the near miss must rank first");
    eq(e.fix, "ALFA TAN [5101]");
  });

  await test("a pin settles a name the matcher will not guess at", async () => {
    const p = plan(P,
      "SECTION 1 — 3\nALFA TAN [5101] — 🟢 AI\nBRAVO LIM — 🟢 AI\nCHARLIE NG — 🟢 AI\n" +
      "SECTION 2 — 2\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\n");
    ok(p.ok, JSON.stringify(p.issues));
    // Pinned to ALPHA TAN, and it is the ROSTER's spelling that is carried.
    ok([...p.moves, ...p.unchanged].some((r) => r.oldId === "5101" && r.name === "ALPHA TAN"));
  });

  await test("a pin to someone outside the platoon BLOCKS", async () => {
    const p = plan(P,
      "SECTION 1 — 3\nALFA TAN [7101] — 🟢 AI\nBRAVO LIM — 🟢 AI\nCHARLIE NG — 🟢 AI\n" +
      "SECTION 2 — 2\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\n");
    ok(!p.ok);
    ok(p.issues.some((i) => /pinned to 7101/.test(i.message)));
  });

  await test("a man left off the list BLOCKS — the platoon must be accounted for", async () => {
    const p = plan(P,
      "SECTION 1 — 2\nALPHA TAN — 🟢 AI\nBRAVO LIM — 🟢 AI\n" +
      "SECTION 2 — 2\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\n");
    ok(!p.ok);
    eq(p.moves, []);
    const e = p.issues.find((i) => /not on the list/.test(i.message));
    ok(e && /5103/.test(e.message), JSON.stringify(p.issues));
  });

  await test("two lines resolving to the same man BLOCKS", async () => {
    const p = plan(P,
      "SECTION 1 — 3\nALPHA TAN — 🟢 AI\nALFA TAN [5101] — 🟢 AI\nCHARLIE NG — 🟢 AI\n" +
      "SECTION 2 — 2\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\n");
    ok(!p.ok);
    ok(p.issues.some((i) => /both resolve to 5101/.test(i.message)), JSON.stringify(p.issues));
  });

  await test("two men with the same name BLOCK rather than being picked between", async () => {
    const roster = [
      { id: "5101", name: "ALPHA TAN", role: "Recruit", pid: "P-1" },
      { id: "5102", name: "ALPHA TAN", role: "Recruit", pid: "P-2" },
    ];
    const p = plan(P, "SECTION 1 — 2\nALPHA TAN — 🟢 AI\nALPHA TAN — 🟢 AI\n", roster);
    ok(!p.ok);
    ok(p.issues.some((i) => /matches 2 recruits/.test(i.message)), JSON.stringify(p.issues));
  });

  await test("an empty platoon BLOCKS rather than planning nothing", async () => {
    const p = plan(P, "SECTION 1 — 1\nALPHA TAN — 🟢 AI\n", ROSTER, 8);
    ok(!p.ok);
    ok(p.issues.some((i) => /no recruits found in platoon 8/.test(i.message)));
  });

  suite("reseat — ranking a near miss");

  await test("bigrams see a typo inside a token that token-sets are blind to", async () => {
    // The real failure mode: "BAHAGGI" and "BAIHAQQI" share no whole token, so
    // token-set similarity scores them 0 through the surname alone, while a
    // human reads them as obviously the same man.
    const near = P.rankScore("AHMAD BAHAGGI BIN JURAIMI", "AHMAD BAIHAQQI BIN JURAIMI");
    const far = P.rankScore("AHMAD BAHAGGI BIN JURAIMI", "ECHO SIM");
    ok(near > 0.7, `near=${near}`);
    ok(near > far * 3, `near=${near} far=${far}`);
  });

  await test("the report never prints names unless asked", async () => {
    const p = plan(P,
      "SECTION 1 — 2\nCHARLIE NG — 🟢 AI\nALPHA TAN — 🟢 AI\n" +
      "SECTION 2 — 3\nDELTA WONG — 🟢 AI\nECHO SIM — 🟢 AI\nBRAVO LIM — 🟢 AI\n");
    const quiet = P.formatReseatReport(p);
    ok(!/BRAVO/.test(quiet), "a report pasted into a chat must not carry names");
    ok(/READY/.test(quiet));
    ok(/BRAVO/.test(P.formatReseatReport(p, { names: true })));
  });
}

module.exports = main;
