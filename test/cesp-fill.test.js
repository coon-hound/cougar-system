// Tests for the CESP badge form import (scripts/cesp-fill.mjs).
//
// The form has no 4D, so the part worth testing is who a row lands on: only an
// exact name in the right platoon and section, or a hand pin. Names here are
// invented - this repository is public.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

const HEAD = "Timestamp,Rank/Name (e.g. PTE  ALPHA TAN,PLATOON,SECTION," +
  "THT-TRAINED WEAPON ELIGIBILITY (NON SAR) [PRIMARY WEAPON],THT-TRAINED WEAPON ELIGIBILITY (NON SAR) [SECONDARY WEAPON]," +
  "PES (CHECK ONENS),CPR/AED TRAINED (CHECK ONENS),BASIC DRONE PACKAGE COMPLETION (CHECK ONENS),LATEST SOC QUALIFICATION (CHECK ONENS)\n";
const row = (name, plt, sect, p1, p2, pes, cpr, drone, soc) =>
  `10/21/2026 10:38:31,"${name}",${plt},${sect},${p1},${p2},${pes},${cpr},${drone},${soc}\n`;

const ROSTER = [
  { id: "7101", name: "ALPHA TAN WEI" },
  { id: "7203", name: "MUHAMMAD BRAVO BIN CHARLIE" },
  { id: "8104", name: "DELTA LIM" },
  { id: "8305", name: "DELTA LIM" },        // same name, two seats
  { id: "9402", name: "ECHO NG KAI" },
];

async function main() {
  const F = await import(pathToFileURL(path.join(ROOT, "scripts/cesp-fill.mjs")).href);

  suite("cesp-fill - reading the form");

  await test("every column maps, NOT TRAINED is blank, Never do SOC is None", () => {
    const p = F.planCesp(HEAD + row("Wei Tan Alpha", 7, 1, "MATADOR", "NOT TRAINED", "B1", "QUALIFIED", "NOT QUALIFIED", "Never do SOC"), ROSTER);
    eq(p.skipped, []);
    eq(p.rows.length, 1);
    eq(p.rows[0].id, "7101");
    eq(p.rows[0].columns, { pes: "B1", socLevel: "None", thtPrimary: "MATADOR" });
    eq(p.rows[0].quals, ["CPR/AED"]);
  });

  await test("an unknown weapon or PES skips the row rather than storing junk", () => {
    const p = F.planCesp(HEAD + row("ALPHA TAN WEI", 7, 1, "RIFLE", "LMG", "Z9", "QUALIFIED", "QUALIFIED", "SOC5"), ROSTER);
    eq(p.rows.length, 0);
    ok(/thtPrimary/.test(p.skipped[0].why) && /PES/.test(p.skipped[0].why));
  });

  suite("cesp-fill - which seat a row lands on");

  await test("BIN carries no information: the name matches in any order", () => {
    const p = F.planCesp(HEAD + row("BRAVO CHARLIE MUHAMMAD", 7, 2, "LMG", "M203", "A", "QUALIFIED", "QUALIFIED", "SOC4"), ROSTER);
    eq(p.rows.map(r => r.id), ["7203"]);
  });

  await test("a right name in the wrong platoon/section is not written", () => {
    const p = F.planCesp(HEAD + row("ECHO NG KAI", 9, 3, "LMG", "M203", "A", "QUALIFIED", "QUALIFIED", "SOC4"), ROSTER);
    eq(p.rows.length, 0);
    ok(/9402/.test(p.skipped[0].why));
  });

  await test("a near-miss spelling is skipped with the closest seats, never guessed", () => {
    const p = F.planCesp(HEAD + row("ECHO NG KAY", 9, 4, "LMG", "M203", "A", "QUALIFIED", "QUALIFIED", "SOC4"), ROSTER);
    eq(p.rows.length, 0);
    ok(/no exact name match/.test(p.skipped[0].why));
    ok(p.skipped[0].near.some(n => n.startsWith("9402")));
  });

  await test("a name on two seats is ambiguous; a pin settles it", () => {
    const csv = HEAD + row("DELTA LIM", 8, 3, "M203", "LMG", "B2", "NOT QUALIFIED", "QUALIFIED", "SOC3");
    eq(F.planCesp(csv, ROSTER).rows.length, 0);
    const p = F.planCesp(csv, ROSTER, new Map([[2, "8305"]]));
    eq(p.rows.map(r => [r.id, r.how]), [["8305", "pinned"]]);
    eq(p.rows[0].quals, ["Basic Drone"]);
  });

  await test("a pin to a seat that does not exist is refused", () => {
    const p = F.planCesp(HEAD + row("NOBODY", 7, 1, "LMG", "M203", "A", "QUALIFIED", "QUALIFIED", "SOC4"), ROSTER, new Map([[2, "7999"]]));
    eq(p.rows.length, 0);
    ok(/7999/.test(p.skipped[0].why));
  });

  await test("two form rows on one seat: neither is trusted", () => {
    const csv = HEAD + row("ALPHA TAN WEI", 7, 1, "LMG", "M203", "A", "QUALIFIED", "QUALIFIED", "SOC4")
                     + row("TAN ALPHA WEI", 7, 1, "MATADOR", "", "B1", "QUALIFIED", "QUALIFIED", "SOC5");
    const p = F.planCesp(csv, ROSTER);
    eq(p.rows.length, 0);
    eq(p.skipped.map(s => s.line), [2, 3]);
  });

  suite("cesp-fill - quals are only ever added");

  await test("existing quals and their expiry survive; a held qual is not re-added", () => {
    const q = F.addQuals("CPR/AED@2027-03-31, Range Safety", ["CPR/AED", "Basic Drone"]);
    eq(q.value, "CPR/AED@2027-03-31, Range Safety, Basic Drone");
    eq(q.added, ["Basic Drone"]);
    eq(F.addQuals("", ["CPR/AED"]).value, "CPR/AED");
  });

  await test("--pin parses LINE=4D and rejects anything else", () => {
    const a = F.parseArgs(["f.csv", "--pin", "84=930", "--apply"]);
    eq(a.file, "f.csv"); eq(a.apply, true); eq(a.pins.get(84), "0930"); eq(a.errors, []);
    eq(F.parseArgs(["f.csv", "--pin", "9302"]).errors.length, 1);
  });
}

module.exports = main;
