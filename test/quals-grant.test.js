// Tests for scripts/quals-grant.mjs: one qualification for everyone on the
// roster EXCEPT the men on a list. The part worth testing is who is excluded:
// a listed man the script cannot place must never be granted it silently.
// Names and NRICs here are invented - this repository is public.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const H = (s) => require("crypto").createHash("sha256").update(String(s)).digest("hex");
const QUAL = "PTCO JVLF";

const ROSTER = [
  { id: "0001", name: "OSCAR COMD", pid: "P-OSCAR", role: "Commander", quals: "" },
  { id: "0101", name: "HOTEL QUEBEC", pid: "P-HOTEL", role: "Recruit", quals: "" },
  { id: "7101", name: "ALPHA TAN", pid: "P-ALPHA", role: "Recruit", quals: "CPR/AED" },
  { id: "7102", name: "MUHAMMAD BRAVO BIN CHARLIE", pid: "P-BRAVO", role: "Recruit", quals: "" },
  { id: "7103", name: "DELTA LIM", pid: "P-DELTA", role: "Recruit", quals: "PTCO JVLF" },
  { id: "7104", name: "ECHO NG", pid: null, role: "Recruit", quals: "" },
];
// Only BRAVO's NRIC is in the registry.
const PID_BY_NRIC = new Map([[H("nric:S1234567D"), "P-BRAVO"]]);

async function main() {
  const G = await import(pathToFileURL(path.join(ROOT, "scripts/quals-grant.mjs")).href);
  const plan = (csv, opts = {}) => G.planGrant(csv, ROSTER, PID_BY_NRIC, H, { qual: QUAL, ...opts });
  const ids = (xs) => xs.map((x) => x.id);

  suite("quals-grant - everyone except the list");

  await test("the list's own headers (S/N, NRIC, FULL NAME, RATION) are read", () => {
    eq(G.parseExceptList("S/N,NRIC,FULL NAME,RATION,Remarks\n1,S1234567D,Bravo,Muslim,\n"),
      [{ line: 2, nric: "S1234567D", name: "Bravo" }]);
  });

  await test("listed men are excluded by NRIC or exact name; everyone else, commanders included, gets it", () => {
    const p = plan("NRIC,FULL NAME\nS1234567D,SOMEONE ELSE ENTIRELY\nT0000000A,Tan Alpha\n");
    eq(p.unplaced, []);
    eq(p.excluded.map((e) => [e.line, e.id, e.how]), [[2, "7102", "nric"], [3, "7101", "name"]]);
    ok(/name differs/.test(p.excluded[0].warn), "an NRIC match under another name is flagged, not trusted silently");
    eq(ids(p.grant), ["0001", "0101", "7104"]);
    eq(ids(p.already), ["7103"], "a man who already holds it is not written again");
  });

  await test("a listed man who cannot be placed is UNPLACED, never granted", () => {
    const p = plan("NRIC,FULL NAME\nT9999999Z,ECHO NGG\n");
    eq(p.unplaced.length, 1);
    ok(/no NRIC or exact name match/.test(p.unplaced[0].why));
    ok(p.unplaced[0].near.some((n) => n.startsWith("7104")), "the near miss is offered: " + p.unplaced[0].near);
  });

  await test("--pin places a line; --skip drops one that is not on the roster", () => {
    const p = plan("NRIC,FULL NAME\nT9999999Z,ECHO NGG\nT8888888Y,NOT SEATED\n", { pins: new Map([[2, "7104"]]), skips: new Set([3]) });
    eq(p.unplaced, []);
    eq(p.excluded.map((e) => [e.id, e.how]), [["7104", "pinned"]]);
    eq(p.skipped, [{ line: 3 }]);
    ok(!ids(p.grant).includes("7104"));
  });

  await test("two list lines on one seat are both refused", () => {
    const p = plan("NRIC,FULL NAME\nS1234567D,X\n,Bravo Bin Charlie Muhammad\n");
    eq(p.unplaced.map((u) => u.line), [2, 3]);
  });

  await test("a malformed NRIC is refused rather than guessed", () => {
    const p = plan("NRIC,FULL NAME\nS12345,ALPHA TAN\n");
    ok(/not a full NRIC/.test(p.unplaced[0].why));
  });

  await test("an excluded man who already holds it keeps it (only ever adds)", () => {
    const p = plan("NRIC,FULL NAME\n,DELTA LIM\n");
    eq(p.excludedHolding, ["7103"]);
  });

  await test("arguments: --qual and --except are required; a qual cannot hold , or @", () => {
    ok(G.parseArgs([]).errors.length >= 2);
    ok(G.parseArgs(["--qual", "A, B", "--except", "x.csv"]).errors.some((e) => /cannot contain/.test(e)));
    const a = G.parseArgs(["--qual", QUAL, "--except", "x.csv", "--pin", "5=93", "--skip", "7", "--apply"]);
    eq([a.errors, a.qual, a.file, [...a.pins], [...a.skips], a.apply], [[], QUAL, "x.csv", [[5, "0093"]], [7], true]);
  });
}

module.exports = main;
