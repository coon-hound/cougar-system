// Tests for the late-form profile fill (scripts/profile-fill.mjs).
//
// The write itself is an UPDATE of empty fields; the part worth testing is who
// it lands on. A 4D typed one digit off must never put one man's next of kin on
// another. Names here are invented - this repository is public.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const H = (s) => require("crypto").createHash("sha256").update(String(s)).digest("hex");

const ROSTER = [
  { id: "7101", name: "ALPHA TAN", pid: "P-ALPHA" },
  { id: "7102", name: "MUHAMMAD BRAVO BIN CHARLIE", pid: "P-BRAVO" },
];

async function main() {
  const F = await import(pathToFileURL(path.join(ROOT, "scripts/profile-fill.mjs")).href);

  suite("profile-fill — which seat a late form lands on");

  await test("a row fills the man in its 4D, in any name order, with roll-format headers", () => {
    const csv = "4D,Name,NRIC,HP,Blood Type,NOK Name,MSK,Education,Vocation Code\n" +
                "7102,Bravo Bin Charlie Muhammad,S1234567D,91234567,O+,DELTA,Knee,ITE,X11\n";
    const p = F.planFill(csv, ROSTER, H);
    eq(p.issues, []);
    eq(p.rows.length, 1);
    eq(p.rows[0].id, "7102");
    eq(p.rows[0].pid, "P-BRAVO");
    eq(p.rows[0].fields, {
      phone: "91234567", bloodType: "O+", nokName: "DELTA", msk: "Knee", "highest education level": "ITE",
    });
    eq(p.unknown, ["Vocation Code"], "a column the system does not keep is skipped and reported");
  });

  await test("a 4D whose man has a different name BLOCKS - nothing lands on the wrong seat", () => {
    const p = F.planFill("4D,Name,HP\n7101,ECHO SIM,91234567\n", ROSTER, H);
    eq(p.rows, []);
    ok(/does not match the man in 7101/.test(p.issues[0]), p.issues[0]);
  });

  await test("an unknown seat, or a seat listed twice, BLOCKS", () => {
    ok(/not a seat/.test(F.planFill("4D,Name\n9999,ALPHA TAN\n", ROSTER, H).issues[0]));
    ok(/listed twice/.test(F.planFill("4D,Name\n7101,ALPHA TAN\n7101,ALPHA TAN\n", ROSTER, H).issues[0]));
  });

  await test("the raw NRIC never leaves the planner; a partial one is refused", () => {
    const p = F.planFill("4D,Name,NRIC\n7101,ALPHA TAN,S1234567D\n", ROSTER, H);
    ok(!JSON.stringify(p).includes("S1234567D"));
    ok(p.rows[0].nricHash);
    ok(/not a full NRIC/.test(F.planFill("4D,Name,NRIC\n7101,ALPHA TAN,567D\n", ROSTER, H).issues[0]));
  });

  await test("blank cells are not writes", () => {
    const p = F.planFill("4D,Name,HP,Blood Type\n7101,ALPHA TAN,,\n", ROSTER, H);
    eq(p.rows[0].fields, {});
  });
}

module.exports = main;
