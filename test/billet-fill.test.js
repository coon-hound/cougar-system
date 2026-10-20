// Tests for the section-role fill (scripts/billet-fill.mjs).
//
// The list is keyed by name, so the part worth testing is that a role only
// ever lands on an exact match to one man. Names here are invented - this
// repository is public.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

const ROSTER = [
  { id: "7101", name: "ALPHA TAN WEI" },
  { id: "7102", name: "MUHAMMAD BRAVO BIN CHARLIE" },
  { id: "7103", name: "DELTA LIM" },
  { id: "7201", name: "LIM DELTA" },
];

async function main() {
  const F = await import(pathToFileURL(path.join(ROOT, "scripts/billet-fill.mjs")).href);

  suite("billet-fill - which seat a role lands on");

  await test("an exact name in any order lands on its seat, with the list's own headers", () => {
    const p = F.planBillets("FULL NAME (AS PER BIRTH CERTIFICATE),Roles\nWei Tan Alpha,1 LMG\nMUHAMMAD BRAVO BIN CHARLIE, LAW  2IC \n", ROSTER);
    eq(p.issues, []);
    eq(p.rows.map((r) => [r.id, r.billet]), [["7101", "1 LMG"], ["7102", "LAW 2IC"]]);
  });

  await test("a partial name BLOCKS and names the closest seat - it is never guessed", () => {
    const p = F.planBillets("Name,Role\nALPHA TAN,GL\n", ROSTER);
    eq(p.rows, []);
    ok(/not on the current roster.*7101 ALPHA TAN WEI/.test(p.issues[0]), p.issues[0]);
  });

  await test("two men with the same name BLOCK", () => {
    ok(/matches 2 men \(7103, 7201\)/.test(F.planBillets("Name,Role\nDELTA LIM,GL\n", ROSTER).issues[0]));
  });

  await test("the same man listed twice BLOCKS", () => {
    ok(/already listed on line 2/.test(F.planBillets("Name,Role\nALPHA TAN WEI,GL\nTAN ALPHA WEI,M203\n", ROSTER).issues[0]));
  });

  await test("a blank role or 'Role Unassigned' clears it", () => {
    const p = F.planBillets("Name,Role\nALPHA TAN WEI,Role Unassigned\nMUHAMMAD BRAVO BIN CHARLIE,\n", ROSTER);
    eq(p.rows.map((r) => r.billet), ["", ""]);
  });

  await test("a list without a role column is refused", () => {
    ok(/needs a name column and a role column/.test(F.planBillets("Name\nALPHA TAN WEI\n", ROSTER).issues[0]));
  });
}

module.exports = main;
