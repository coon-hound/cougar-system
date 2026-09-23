// Tests for the IPPT screenshot import (scripts/ippt-import-plan.mjs) and the
// scoring tables it gates on (js/ippt-scoring.js).
//
// The import's accuracy rests on three independent checks - two reads must
// agree, the printed total must re-derive from the stations, and a name must
// match the roster exactly - so each is pinned here on its own, including the
// ways it must REFUSE. Names are invented: this repository is public.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const PLAN = pathToFileURL(path.join(ROOT, "scripts/ippt-import-plan.mjs")).href;

function loadScoring() {
  const sandbox = { Math, String, Number };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js/ippt-scoring.js"), "utf8"), sandbox);
  return sandbox;
}
const AGE = { 1: 18, 2: 23, 3: 26 };
const scorer = (S) => (ag, pu, su, run) => S.calculateIPPTScore(AGE[ag], pu, su, run || "0:00").total;

// One OCR box. y is from the top; the app draws a row's numbers ~2px above its
// name, which is the offset that broke the first parser.
const box = (text, x, y) => ({ text, x, y, w: 0.05, h: 0.02, conf: 1 });

module.exports = async function run() {
  const P = await import(PLAN);
  const S = loadScoring();

  suite("ippt scoring - the official tables, checked against real sheet totals");

  await test("sit-ups use their OWN table (it is not the push-up table)", () => {
    const su = (reps) => S.calculateIPPTScore(18, 0, reps, "0:00").situpScore;
    const pu = (reps) => S.calculateIPPTScore(18, reps, 0, "0:00").pushupScore;
    eq(su(37), 18); eq(pu(37), 19);
    eq(su(30), 13); eq(pu(30), 16);
    eq(su(25), 9);  eq(pu(25), 14);
    eq(su(18), 4);  eq(pu(18), 6);
  });

  await test("a run scores the band it falls in: 12:02 is in 12:01-12:10", () => {
    const run = (t, age = 18) => S.calculateIPPTScore(age, 0, 0, t).runScore;
    eq(run("12:00"), 33, "12:00 closes the 11:51-12:00 band");
    eq(run("12:02"), 32, "Math.round used to put this in the 33 band");
    eq(run("10:18"), 39);
    eq(run("8:30"), 50); eq(run("8:31"), 49);
    eq(run("16:00"), 1); eq(run("16:01"), 0);
  });

  await test("0:00 (no run) scores 0, not the 50 of an impossibly fast run", () => {
    eq(S.calculateIPPTScore(18, 0, 0, "0:00").runScore, 0);
  });

  await test("totals printed on real KH and BMT sheets re-derive exactly", () => {
    const t = scorer(S);
    eq(t(1, 56, 50, "12:02"), 78);
    eq(t(1, 34, 44, "12:23"), 69);
    eq(t(2, 60, 52, "12:59"), 76, "AG2: 10s more on the run");
    eq(t(3, 25, 53, "14:08"), 60, "AG3: the one KH 1 man only group 3 explains");
    eq(t(1, 37, 48, "11:14"), 77);
  });

  suite("ippt import - parsing a screenshot's OCR boxes");

  const SHOT = {
    file: "shot-a.jpeg",
    items: [
      box("DETAIL 4", 0.14, 0.119),
      // row 3 - numbers 2px above the name line, name wraps onto two lines
      box("56", 0.591, 0.231), box("50", 0.708, 0.231), box("12:02 :", 0.811, 0.231),
      box("3. PTE ALPHA ONE BIN", 0.035, 0.233), box("BRAVO", 0.179, 0.260),
      box("Tag No: 394", 0.107, 0.296), box("78 pts", 0.808, 0.296),
      // row 4 - did not register
      box("-", 0.591, 0.382), box("-", 0.714, 0.384),
      box("4. PTE CHARLIE TWO", 0.035, 0.387),
      box("Tag No: Not Registered", 0.107, 0.424),
      // the list legend, scrolled up next to row 5
      box('complete the station. "E" indicates excused.', 0.04, 0.55),
      // row 5 - cut at the bottom edge, its Tag line off screen
      box("11.21", 0.814, 0.96), box("5. PTE DELTA THREE", 0.035, 0.962),
    ],
  };

  await test("a row's numbers, wrapped name, tag and total land on ONE row", () => {
    const rows = P.parseShot(SHOT);
    eq(rows.length, 3);
    const r = rows[0];
    eq([r.detail, r.idx, r.rank, r.name], [4, 3, "PTE", "ALPHA ONE BIN BRAVO"]);
    eq([r.pu, r.su, r.run, r.tag, r.pts], ["56", "50", "12:02", "394", "78"]);
    eq([r.cutTop, r.cutBottom], [false, false]);
  });

  await test("the list legend is not read as anybody's name", () => {
    const rows = P.parseShot(SHOT);
    ok(rows.every((r) => !/indicates/.test(r.name || "")), JSON.stringify(rows.map((r) => r.name)));
  });

  await test("a row cut by the bottom edge is marked, not trusted", () => {
    const r = P.parseShot(SHOT)[2];
    eq(r.idx, 5); eq(r.cutBottom, true);
  });

  await test("a row whose head scrolled off takes its index from the next row", () => {
    const rows = P.inferIndexes([
      { shot: "b", idx: null, cutTop: true },
      { shot: "b", idx: 8 }, { shot: "b", idx: 9 },
    ]);
    eq(rows[0].idx, 7);
  });

  suite("ippt import - two independent reads must agree");

  const ocr = (o) => ({ shot: "o1", detail: 1, idx: 1, rank: "PTE", name: "ALPHAONE", pu: "40", su: "41", run: "11:00", tag: "7", pts: "76", ...o });
  const vis = (o) => ({ shot: "v1", detail: 1, idx: 1, rank: "PTE", name: "ALPHA ONE", pu: "40", su: "41", run: "11:00", tag: "7", pts: "76", cut: null, ...o });

  await test("agreement is accepted, and the name comes from the visual read", () => {
    const { rows, problems } = P.reconcile([ocr()], [vis()]);
    eq(problems, []);
    eq([rows[0].pu, rows[0].su, rows[0].run, rows[0].pts, rows[0].name, rows[0].status], ["40", "41", "11:00", "76", "ALPHA ONE", "result"]);
  });

  await test("a disagreement stops the field, it is never resolved by a vote", () => {
    const { rows, problems } = P.reconcile([ocr({ pu: "46" })], [vis(), vis({ shot: "v2" })]);
    eq(rows[0].pu, null);
    eq(problems.map((p) => [p.field, p.why]), [["pu", "reads disagree"]]);
  });

  await test("a number only one source read is not accepted", () => {
    const { problems } = P.reconcile([ocr({ pu: null })], [vis()]);
    eq(problems.map((p) => [p.field, p.why]), [["pu", "only one source read it"]]);
  });

  await test("an overlapping screenshot that disagrees with itself stops the run", () => {
    const { problems } = P.reconcile([ocr(), ocr({ shot: "o2", su: "47" })], [vis()]);
    eq(problems.map((p) => p.field), ["su"]);
  });

  await test("a clipped appearance cannot vouch for the numbers", () => {
    // o2 cut at the bottom read "11.21" - it must not count, for or against.
    const { rows, problems } = P.reconcile([ocr(), ocr({ shot: "o2", run: "11.21", cutBottom: true })], [vis()]);
    eq(problems, []); eq(rows[0].run, "11:00");
  });

  await test("one read of '-' against no text at all is a dash; against a number it is not", () => {
    const dns = { pu: "-", su: "-", run: "-", pts: null };
    const a = P.reconcile([ocr({ ...dns, run: null })], [vis(dns)]);
    eq(a.problems, []); eq(a.rows[0].status, "dns");
    const b = P.reconcile([ocr({ run: "12:00" })], [vis({ run: "-" })]);
    eq(b.problems.map((p) => p.field), ["run"]);
  });

  await test("a Not Registered row needs only its status to agree", () => {
    const nr = { pu: "-", su: "-", run: "-", tag: "Not Registered", pts: null };
    const { rows, problems } = P.reconcile([ocr({ ...nr, run: null })], [vis(nr)]);
    eq(problems, []); eq(rows[0].status, "not-registered");
  });

  suite("ippt import - the scoring cross-check (the printed score is never replaced)");

  await test("a result passes when some age group re-derives its total, and fails otherwise", () => {
    const rows = [
      { detail: 1, idx: 1, status: "result", pu: "56", su: "50", run: "12:02", pts: "78" },
      { detail: 1, idx: 2, status: "result", pu: "56", su: "50", run: "12:02", pts: "90" },
      { detail: 1, idx: 3, status: "dns", pu: "-", su: "-", run: "-", pts: "0" },
    ];
    const failures = P.gate(rows, scorer(S));
    eq(failures.map((f) => f.key), ["1:2"]);
    eq(rows[0].ageGroup, "1");
  });

  await test("a misread push-up count that changes the points is flagged by the cross-check", () => {
    // 56 -> 36 push-ups is 24 -> 18 points: the printed 78 no longer re-derives.
    const rows = [{ detail: 1, idx: 1, status: "result", pu: "36", su: "50", run: "12:02", pts: "78" }];
    eq(P.gate(rows, scorer(S)).length, 1);
  });

  await test("the PRINTED score is what the plan writes, even when the tables disagree", () => {
    const rows = [{ detail: 1, idx: 1, status: "result", rank: "PTE", name: "CHARLIE TWO", pu: "56", su: "50", run: "12:02", pts: "91" }];
    eq(P.gate(rows, scorer(S)).length, 1, "flagged");
    P.matchNames(rows, [{ id: "7102", name: "CHARLIE TWO", role: "Recruit" }]);
    const plan = P.planImport({ rows, series: "KH", attempt: "1", date: "23 Sep 2026" });
    eq(plan.insert[0].row.score, "91");
  });

  suite("ippt import - name to 4D");

  const ROSTER = [
    { id: "7101", name: "ALPHA ONE BIN BRAVO", role: "Recruit" },
    { id: "7102", name: "CHARLIE TWO", role: "Recruit" },
    { id: "7103", name: "ECHO KAI FOXTROT", role: "Recruit" },
    { id: "0003", name: "GOLF HOTEL", role: "Commander" },
  ];
  const row = (idx, name, o = {}) => ({ detail: 1, idx, name, rank: "PTE", status: "result", pu: "40", su: "40", run: "11:00", pts: "75", ...o });

  await test("an exact token set matches in any order, ignoring BIN and punctuation", () => {
    const rows = P.matchNames([row(1, "BRAVO, ALPHA ONE"), row(2, "TWO CHARLIE")], ROSTER);
    eq(rows.map((r) => [r.match.d4, r.match.how]), [["7101", "exact"], ["7102", "exact"]]);
  });

  await test("a one-letter difference is NOT matched - it is ranked for a human", () => {
    const [r] = P.matchNames([row(1, "ECHO KAH FOXTROT")], ROSTER);
    eq(r.match.d4, undefined);
    eq(r.match.candidates[0].d4, "7103");
  });

  await test("a pin decides a near miss, and one 4D can never take two rows", () => {
    const rows = P.matchNames([row(1, "ECHO KAH FOXTROT"), row(2, "CHARLIE TWO")], ROSTER, { "1:1": "7102" });
    eq(rows[0].match.d4, "7102");
    ok(/already taken/.test(rows[1].match.error), rows[1].match.error);
  });

  await test("a man who left mid-intake is recognised by his archive row", () => {
    const [r] = P.matchNames([row(1, "INDIA JULIET")], ROSTER, {}, [{ id: "7104@16-out-20260921", name: "INDIA JULIET" }]);
    eq(r.match.departed, "7104@16-out-20260921");
  });

  suite("ippt import - the plan");

  await test("results, blanks and exclusions each go where they belong", () => {
    const rows = P.matchNames([
      row(1, "ALPHA ONE BIN BRAVO"),
      row(2, "CHARLIE TWO", { status: "dns", pu: "-", su: "-", run: "-", pts: "0" }),
      row(3, "GOLF HOTEL", { rank: "3SG" }),
      row(4, "ECHO KAI FOXTROT", { status: "not-registered", pu: null, su: null, run: null, pts: null }),
      row(5, "INDIA JULIET"),
    ], ROSTER, {}, [{ id: "7104@16-out-20260921", name: "INDIA JULIET" }]);
    const plan = P.planImport({ rows, series: "KH", attempt: "1", date: "23 Sep 2026" });
    eq(plan.insert.map((x) => x.row), [
      { id: "ippt-kh1-7101", d4: "7101", attempt: "1", date: "23 Sep 2026", pushups: "40", situps: "40", runTime: "11:00", score: "75", series: "KH" },
      { id: "ippt-kh1-7102", d4: "7102", attempt: "1", date: "23 Sep 2026", pushups: "0", situps: "0", runTime: "0:00", score: "0", series: "KH" },
    ]);
    eq(plan.excluded.length, 3);
    eq(plan.unmatched, []);
  });

  await test("re-running is idempotent, and a different stored result is a conflict", () => {
    const rows = P.matchNames([row(1, "ALPHA ONE BIN BRAVO"), row(2, "CHARLIE TWO")], ROSTER);
    const existing = [
      { d4: "7101", attempt: "1", series: "KH", date: "23 Sep 2026", pushups: "40", situps: "40", runTime: "11:00", score: "75" },
      { d4: "7102", attempt: "1", series: "KH", date: "23 Sep 2026", pushups: "41", situps: "40", runTime: "11:00", score: "75" },
      { d4: "7102", attempt: "1", series: "BMT", date: "26 May 2026", pushups: "9", situps: "9", runTime: "15:00", score: "10" },
    ];
    const plan = P.planImport({ rows, existing, series: "KH", attempt: "1", date: "23 Sep 2026" });
    eq([plan.insert.length, plan.same.length, plan.conflicts.length], [0, 1, 1]);
    eq(plan.conflicts[0].row.d4, "7102");
  });

  await test("the verification CSV quotes a comma in a name", () => {
    const rows = P.matchNames([row(1, "CHARLIE TWO")], ROSTER);
    rows[0].name = "TWO, CHARLIE";
    ok(P.verificationCsv(rows).includes('"TWO, CHARLIE"'));
  });
};
