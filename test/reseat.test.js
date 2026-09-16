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
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const PLAN = pathToFileURL(path.join(ROOT, "scripts/reseat-plan.mjs")).href;

// Every name that may legitimately appear in a SECTION example anywhere in this
// repository. Adding one is a deliberate act — which is the entire point.
//
// This list exists because a real platoon's section list DID land in this
// public repository once: the operator's pasted list is the natural thing to
// copy into a doc comment or a test, it arrives full of real names, and one of
// them was written next to its real 4D. `*.csv` is gitignored for the same
// reason (see CLAUDE.md); this covers the vector gitignore cannot.
const INVENTED_NAMES = new Set([
  "ALPHA TAN", "BRAVO LIM", "CHARLIE NG", "DELTA WONG", "ECHO SIM",
  "FOXTROT KOH", "ZULU COMMANDER", "ALFA TAN",
  "LI WEI", "NG SOON KIT DARREN", "GORDON YEO",
  "NUR-HAKIM BIN SALLEH", "ZAKIR MAHFUZ BIN OMAR", "ZAKIR MAHFOOZ BIN OMAR",
]);

// Files that can carry a SECTION example at all. Everything else must not.
const SCANNED = [
  "docs/RESEAT.md", "scripts/reseat-plan.mjs", "scripts/reseat.mjs",
  "test/reseat.test.js",
];

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
    // Splitting on "-" instead of the em dash truncates "NUR-HAKIM" to "NUR".
    const { sections } = P.parseSections("SECTION 1 — 1\nNUR-HAKIM BIN SALLEH — 🟢 AI\n");
    eq(sections[0].members[0].name, "NUR-HAKIM BIN SALLEH");
  });

  await test("a comma is punctuation, not a separator", async () => {
    const { sections } = P.parseSections("SECTION 1 — 1\nNG SOON KIT, DARREN — 🟢 AI\n");
    eq(sections[0].members[0].name, "NG SOON KIT DARREN");
  });

  await test("tolerates a missing space before the dash and trailing spaces", async () => {
    const { sections } = P.parseSections("SECTION 1 — 2\nGORDON YEO— 🟢 AI\nALPHA TAN  — 🔴 Gunner\n");
    eq(sections[0].members.map((m) => m.name), ["GORDON YEO", "ALPHA TAN"]);
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
    // The real failure mode: "MAHFUZ" and "MAHFOOZ" share no whole token, so
    // token-set similarity scores them 0 through the surname alone, while a
    // human reads them as obviously the same man.
    const near = P.rankScore("ZAKIR MAHFUZ BIN OMAR", "ZAKIR MAHFOOZ BIN OMAR");
    const far = P.rankScore("ZAKIR MAHFUZ BIN OMAR", "ECHO SIM");
    ok(near > 0.7, `near=${near}`);
    ok(near > far * 3, `near=${near} far=${far}`);
  });

  suite("reseat — a two-man seat swap");

  // Why this mode exists: re-dealing the whole platoon assigns 4Ds by POSITION
  // in the list, so "these two exchange sections" would re-number every man
  // below them as well - re-issuing invites and busting caches for men who did
  // not move. A swap is the exact expression of the real-world change.
  const swap = (P, a, b, opts = {}) =>
    P.planSwap({ roster: opts.roster ?? ROSTER, a, b, plt: opts.plt });

  await test("two men exchange their existing 4Ds, and nobody else moves", () => {
    const p = swap(P, "5101", "5202");
    ok(p.ok, "planned: " + JSON.stringify(p.issues));
    eq(p.moves.length, 2, "exactly two moves");
    eq(moveMap(p)["5101"], "5202", "first man takes the second man's seat");
    eq(moveMap(p)["5202"], "5101", "and the second takes the first's");
  });

  await test("the pair is a clean permutation, which is what the rename needs", () => {
    // The apply path renames through a temporary key precisely because the set
    // overlaps itself. That is only safe if the new ids ARE the old ids.
    const p = swap(P, "5101", "5202");
    const olds = p.moves.map((m) => m.oldId).sort();
    const news = p.moves.map((m) => m.newId).sort();
    eq(String(news), String(olds), "the same two seats, exchanged");
  });

  await test("each man can be named by 4D or by name, and the pid comes with him", () => {
    const p = swap(P, "ALPHA TAN", "5202");
    ok(p.ok, "mixed 4D and name: " + JSON.stringify(p.issues));
    eq(moveMap(p)["5101"], "5202");
    // people.last_d4 / d4_history follow the pid, so losing it would leave the
    // person registry pointing at the seat the other man now holds.
    eq(p.moves.find((m) => m.oldId === "5101").pid, "P-ALPHA", "pid carried");
  });

  await test("a name that matches nobody BLOCKS, with ranked candidates", () => {
    const p = swap(P, "ALFA TAN", "5202");
    ok(!p.ok, "blocked");
    const issue = p.issues.find((i) => /nobody on the roster/.test(i.message));
    ok(issue, "says nobody is named that: " + JSON.stringify(p.issues));
    eq(issue.candidates[0].id, "5101", "ranks the man he probably meant first");
  });

  await test("an ambiguous name BLOCKS rather than picking one", () => {
    const twins = ROSTER.concat([{ id: "5203", name: "ALPHA TAN", role: "Recruit", pid: "P-TWIN" }]);
    const p = swap(P, "ALPHA TAN", "5202", { roster: twins });
    ok(!p.ok, "blocked");
    ok(p.issues.some((i) => /matches 2 men/.test(i.message)), JSON.stringify(p.issues));
  });

  await test("swapping a man with himself is refused", () => {
    const p = swap(P, "5101", "ALPHA TAN");
    ok(!p.ok, "blocked");
    ok(p.issues.some((i) => /same man/.test(i.message)), JSON.stringify(p.issues));
  });

  await test("a commander has no section seat to exchange", () => {
    const withCmd = ROSTER.concat([{ id: "0012", name: "ZULU COMMANDER", role: "Commander", pid: "P-CMD" }]);
    const p = swap(P, "0012", "5202", { roster: withCmd });
    ok(!p.ok, "blocked");
    ok(p.issues.some((i) => /not an enlistee/.test(i.message)), JSON.stringify(p.issues));
  });

  await test("--plt is a guard: a name resolving into another platoon BLOCKS", () => {
    // The failure it catches: a name typed for platoon 5 that happens to match
    // a man in platoon 6, swapped without anyone noticing the platoon changed.
    const wider = ROSTER.concat([{ id: "6101", name: "FOXTROT KOH", role: "Recruit", pid: "P-FOX" }]);
    const p = swap(P, "5101", "6101", { roster: wider, plt: 5 });
    ok(!p.ok, "blocked");
    ok(p.issues.some((i) => /is in platoon 6, not 5/.test(i.message)), JSON.stringify(p.issues));
    // Without the guard the same swap is allowed: platoons do exchange men.
    ok(swap(P, "5101", "6101", { roster: wider }).ok, "allowed with no --plt");
  });

  await test("the report names nobody unless --names is asked for", () => {
    const p = swap(P, "5101", "5202");
    const quiet = P.formatSwapReport(p);
    ok(/5101 -> 5202/.test(quiet), "shows the seats: " + quiet);
    ok(!/ALPHA TAN/.test(quiet), "but not the men, so it is safe to paste into a chat");
    ok(/ALPHA TAN/.test(P.formatSwapReport(p, { names: true })), "--names opts in");
  });

  suite("reseat — the runner is wired to the planner");

  // The bug this pins, found by running the thing rather than testing it: the
  // planner was exported and unit-tested, the runner called planSwap, and
  // nobody imported it. Every unit test passed because they all import the
  // PLANNER directly - the one path never exercised was the runner's own
  // import line, which is the only path an operator ever takes.
  await test("every planner function the runner calls is actually imported", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts/reseat.mjs"), "utf8");
    const line = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/reseat-plan\.mjs"/);
    ok(line, "reseat.mjs imports from reseat-plan.mjs");
    const imported = new Set(line[1].split(",").map((t) => t.trim()).filter(Boolean));

    // Everything the planner offers, as actually called in the runner body.
    const body = src.slice(line.index + line[0].length);
    const used = new Set();
    for (const m of body.matchAll(/\b(plan[A-Z]\w*|format\w*Report|parseSections)\s*\(/g)) used.add(m[1]);
    ok(used.size >= 4, "found the call sites: " + [...used].join(", "));
    for (const name of used) ok(imported.has(name), `${name}() is called but not imported`);
  });

  suite("reseat — no real name may reach this public repository");

  // Walk the tree, not just the files above: a SECTION block appearing anywhere
  // ELSE is itself the failure, because that is how a pasted list gets in.
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (/^(node_modules|\.git|test-results|\.claude|\.worktrees)$/.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(md|mjs|js|json|txt|html|gs|ts|sql)$/.test(e.name)) out.push(p);
    }
    return out;
  };

  // Pull SECTION blocks out of a file, tolerating the comment markers they sit
  // behind (" * " in a JSDoc, "// " in a line comment, "\n" escapes in a test
  // string literal), then let the REAL parser decide what counts as a name.
  const namesIn = (text) => {
    const lines = text
      .replace(/\\n/g, "\n")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:\*|\/\/|#)\s?/, "").trim());

    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^SECTION\s+\d/i.test(lines[i])) continue;
      // A member line is "<ALL-CAPS NAME> — <role>". The first line that is not
      // one ends the block — without this bound the scan swallows the rest of
      // the file and every sentence of prose reads as a name.
      const block = [lines[i]];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l || !l.includes("—")) break;
        const namePart = l.split("—")[0].replace(/\[[^\]]*\]/g, "").trim();
        if (!namePart || /[a-z]/.test(namePart)) break;
        block.push(l);
      }
      if (block.length > 1) {
        out.push(
          ...P.parseSections(block.join("\n")).sections.flatMap((s) =>
            s.members.map((m) => m.name),
          ),
        );
      }
    }
    return out;
  };

  await test("every name in a SECTION example is one we invented", async () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      for (const name of namesIn(fs.readFileSync(file, "utf8"))) {
        if (!INVENTED_NAMES.has(name)) offenders.push(`${rel}: ${name}`);
      }
    }
    eq(offenders, [], "unrecognised name in a SECTION example — if it is invented, add it to INVENTED_NAMES");
  });

  await test("SECTION examples live only where we expect them", async () => {
    const found = walk(ROOT)
      .filter((f) => namesIn(fs.readFileSync(f, "utf8")).length)
      .map((f) => path.relative(ROOT, f))
      .sort();
    const unexpected = found.filter((f) => !SCANNED.includes(f));
    eq(unexpected, [], "a pasted section list reached a file that should not carry one");
  });

  await test("no name sits next to a 4D outside the pin syntax", async () => {
    // The worst single line that leaked was a name and its real 4D on the same
    // line of a report example. The pin form (name, then the 4D in brackets) is
    // legitimate; the candidate-ranking column — 4D, percentage, then the name —
    // is the shape that gave the pairing away, and a pairing is exactly what
    // eight encrypted Roster columns exist to prevent.
    const bad = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      if (!SCANNED.includes(rel)) continue;
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        const m = line.match(/\b\d{4}\b\s+\d{1,3}%\s+([A-Z][A-Z' -]{3,})/);
        if (m && !INVENTED_NAMES.has(m[1].trim())) bad.push(`${rel}:${i + 1}: ${m[1].trim()}`);
      });
    }
    eq(bad, [], "a 4D is printed beside a name that is not an invented one");
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
