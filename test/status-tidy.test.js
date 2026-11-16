// scripts/status-tidy.mjs: the plan it writes to the medical table.
const { suite, test, ok, eq } = require("./_tap");

module.exports = async function run() {
  const { planTidy, summarise, loadApp } = await import("../scripts/status-tidy.mjs");
  const app = loadApp();
  const rows = (list) => list.map((status, i) => ({ id: "m" + i, status }));

  suite("status-tidy: what it would write");

  await test("renames stored spellings to what the app shows", () => {
    const p = planTidy(rows(["Excuse Boots", "Excuse Boots", "Excuse boots", "excuse headgear", "MC", "mc"]), app);
    eq(p.renames.map(r => [r.id, r.to]), [["m2", "Excuse Boots"], ["m3", "Excuse Headgear"], ["m5", "MC"]]);
    eq(p.splits, []);
  });

  await test("leaves rows the app already reads as-is alone", () => {
    const p = planTidy(rows(["MC", "LD", "Excuse RMJ", "RMJ", "NIL", "Pending", "Hospitalisation Leave", "RIB"]), app);
    eq(p.renames.length + p.splits.length, 0);
  });

  await test("splits every combined live/blank firing row into the two excuses", () => {
    const p = planTidy(rows(["Excuse Live Firing, Firing of Blanks", "Excuse live/blank firing", "Excuse from Live Firing, Blank Firing"]), app);
    eq(p.splits.length, 3);
    p.splits.forEach(s => { eq(s.keep, "Excuse Live Firing"); eq(s.add, ["Excuse Blank Firing"]); });
    eq(p.renames, [], "a split row is not also listed as a rename");
  });

  await test("the summary carries statuses and counts only", () => {
    const p = planTidy(rows(["Excuse boots", "Excuse boots", "Excuse Boots", "Excuse Boots", "Excuse Boots", "Excuse live/blank firing"]), app);
    const lines = summarise(p);
    eq(lines[0], ['"Excuse boots" -> "Excuse Boots"', 2]);
    ok(lines.some(([l]) => l.includes('"Excuse Live Firing" + "Excuse Blank Firing"')), "split line");
  });
};
