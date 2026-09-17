// Property + fuzz tests for the 40 SAR parade state. The format is filed to
// battalion every morning and collated into the battalion's strength, so the
// interesting failures are not "it threw" but "it quietly published a number
// that does not add up" or "a record stopped being a record".
//
// Every generated state is checked against the format's own rules:
//   1. the blocks add up to COMPANY, and each block's rank lines add up to it
//   2. every section header's count equals the lines filed under it
//   3. the parser reads back EVERY record line — nothing unparsed, no warnings
//   4. each person is filed in exactly one block
//   5. no record line is ever split, truncated or swallowed by free text
// The inputs are randomised (seeded, so a failure reproduces) and deliberately
// hostile: parentheses and "@" in reasons, newlines pasted from WhatsApp,
// blank names, unknown ranks, orphaned records, missing end dates.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

function loadBundle(state) {
  const sandbox = {
    STATE: state, console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat
  };
  vm.createContext(sandbox);
  const src = ["js/helpers.js", "js/parade-compare.js", "js/forms.js"]
    .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n")
    + "\n;this.generateParadeStateText = generateParadeStateText;"
    + "this.parseParadeState = parseParadeState;"
    + "this.diffParadeStates = diffParadeStates;";
  vm.runInContext(src, sandbox, { filename: "parade-format-bundle.js" });
  return sandbox;
}

// ── The invariant checker ────────────────────────────────
const RULE_DASH = "-".repeat(32);
const STRENGTH_LINE = /^(COMPANY|COY HQ|PL [A-Z0-9]+|OFFICER|WOSPEC|ENLISTEE): (\d+)\/(\d+)$/;
const SECTION_LINE = /^(ATT C|STATUS|REPORT SICK|MA|OFF\/LEAVE|OTHERS): (\d+)$/;
const RECORD_LINE = /^\d+\. \S.* - \S.*$/;

// Returns a list of human-readable violations (empty = the state is well formed).
function checkInvariants(text, parsed, state) {
  const bad = [];
  const lines = text.split("\n");
  const say = (m, extra) => bad.push(m + (extra ? " — " + extra : ""));

  // Structure: header, command team, two rules, then the blocks.
  if (lines[0] !== "40 SAR COUGAR COMPANY") say("company line wrong", lines[0]);
  if (!/^(FIRST|LAST) PARADE STATE$/.test(lines[1])) say("report type wrong", lines[1]);
  if (!/^DATE: \d{6} TIME: \d{4}$/.test(lines[2])) say("date line wrong", lines[2]);
  if (text.split("=".repeat(32)).length !== 3) say("expected exactly two === rules");

  // Every line is one of: header furniture, a strength line, a section header,
  // or a record. A line that is none of those means free text escaped a field.
  const known = l =>
    /^(40 SAR|FIRST PARADE|LAST PARADE|DATE: |CDO: |CDS: |COS: |PDS )/.test(l) ||
    /^[-=]{32}$/.test(l) || STRENGTH_LINE.test(l) || SECTION_LINE.test(l) || RECORD_LINE.test(l);
  lines.forEach((l, i) => { if (!known(l)) say("unrecognised line " + i, JSON.stringify(l)); });

  // 1. Blocks add up to COMPANY; rank lines add up to their block.
  const blocks = text.split("\n" + RULE_DASH + "\n");
  const nums = l => { const m = STRENGTH_LINE.exec(l); return m ? [+m[2], +m[3]] : null; };
  const company = nums(lines.find(l => l.startsWith("COMPANY: ")) || "");
  if (!company) say("no COMPANY line");
  let sum = [0, 0];
  const blockHead = /^(COY HQ|PL [A-Z0-9]+): \d+\/\d+$/;
  blocks.forEach(b => {
    const bl = b.split("\n");
    const headIdx = bl.findIndex(l => blockHead.test(l));
    if (headIdx < 0) return say("block with no strength line", bl[0]);
    const head = nums(bl[headIdx]);
    sum = [sum[0] + head[0], sum[1] + head[1]];
    const cats = bl.slice(headIdx + 1, headIdx + 4).map(nums);
    if (cats.some(c => !c)) return say("block missing its rank lines", bl[headIdx]);
    const catSum = cats.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]);
    if (String(catSum) !== String(head)) say("rank lines do not sum to the block", bl[headIdx] + " vs " + String(catSum));
    if (head[0] > head[1]) say("more present than strength", bl[headIdx]);
  });
  if (company && String(sum) !== String(company)) say("blocks do not sum to COMPANY", String(sum) + " vs " + String(company));
  // The company strength is the whole roster: no body invented, none dropped.
  if (company && company[1] !== state.roster.length) say("COMPANY strength is not the roster size", company[1] + " vs " + state.roster.length);

  // 2. Every section header's count equals the record lines filed under it, and
  // all six appear in every block, in order.
  blocks.forEach(b => {
    const order = [];
    let expecting = null, seen = 0;
    b.split("\n").forEach(l => {
      const sec = SECTION_LINE.exec(l);
      if (sec) {
        if (expecting && seen !== expecting.n) say(`${expecting.name} claims ${expecting.n}, has ${seen}`);
        order.push(sec[1]);
        expecting = { name: sec[1], n: +sec[2] };
        seen = 0;
        return;
      }
      if (RECORD_LINE.test(l)) {
        if (!expecting) say("record line outside any section", l);
        else seen++;
      }
    });
    if (expecting && seen !== expecting.n) say(`${expecting.name} claims ${expecting.n}, has ${seen}`);
    if (String(order) !== "ATT C,STATUS,REPORT SICK,MA,OFF/LEAVE,OTHERS") say("section names/order wrong", String(order));
  });

  // 3. The parser reads back every record line.
  const recordLines = lines.filter(l => RECORD_LINE.test(l)).length;
  if (parsed.unparsed.length) say("unparsed lines", JSON.stringify(parsed.unparsed));
  if (parsed.warnings.length) say("parser warnings", JSON.stringify(parsed.warnings));
  if (parsed.people.length !== recordLines) say("parsed people != record lines", parsed.people.length + " vs " + recordLines);
  if (recordLines && parsed.confidence !== "ours") say("own output not recognised as ours");
  if (parsed.header.dateIso === "" || parsed.header.time === "") say("header did not round-trip");

  // 4. Each person is filed in exactly one block.
  const blockOf = {};
  parsed.people.forEach(p => {
    if (!p.key) return say("person entry with no identity", p.rnRaw);
    if (blockOf[p.key] && blockOf[p.key] !== p.block) say("person filed in two blocks", p.key);
    blockOf[p.key] = p.block;
  });
  return bad;
}

// ── Seeded randomness (a failure reproduces from its seed) ──
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Deliberately awful free text: the characters the line format reserves, a
// pasted newline, a name-like dash, unicode, and empty.
const NASTY = [
  "Fever (38.5)", "Raffles @ Sembawang", "Flu\nsecond line", "Post - op review",
  "high fever, cough & flu", "Sprain — left ankle", "", "   ", "MC (extended) @ home",
  "Ré-check (x2)", "A".repeat(120), "1400 review", "-", "()", "@"
];
const RANKS = ["REC", "3SG", "2SG", "2LT", "CPT", "ME3", "MWO", "", "CDT", "??"];
// Both spellings of Hospitalisation Leave are in the pool on purpose: the
// American one must canonicalise at the read boundary rather than becoming an
// unknown custom status that silently stops counting the man out of camp.
const STATUSES = ["MC", "Warded", "LD", "Excuse RMJ", "Excuse Heavy Load", "Excuse Kneeling", "Pending", "NIL", "Excuse Jumping", "Hospitalisation Leave", "Hospitalization Leave"];
// "Hospitalisation Leave" is a legacy LEAVE type (it predates the medical
// status and is no longer offered in the form). It must still file cleanly.
const LEAVE_TYPES = ["Off-in-Lieu", "Annual Leave", "Weekend", "Night's Out", "Course", "Guard Duty", "NDP", "Other", "", "Compassionate", "Hospitalisation Leave"];
const TIMES = ["0930", "1420", "0700-2100", "930", "", "0800-1200"];

const DATE = "2026-09-15";
const shift = n => {
  const d = new Date(DATE + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const disp = iso => {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${iso.slice(8, 10)} ${M[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
};

function randomState(seed) {
  const r = rng(seed);
  const pick = a => a[Math.floor(r() * a.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const roster = [];
  const nRecruits = int(0, 24);
  const used = new Set();
  for (let i = 0; i < nRecruits; i++) {
    const id = `${int(1, 9)}${int(1, 4)}${String(int(1, 16)).padStart(2, "0")}`;
    if (used.has(id)) continue;
    used.add(id);
    const row = { id, role: "Recruit", name: r() < 0.06 ? "" : `Recruit ${id}`, rank: r() < 0.9 ? "" : pick(RANKS) };
    if (r() < 0.12) { row.outOfCamp = true; row.outSince = DATE; row.outReason = pick(NASTY); }
    if (r() < 0.08) { row.campIn = true; row.campInSince = DATE; }
    roster.push(row);
  }
  for (let i = 0; i < int(0, 5); i++) {
    const id = `00${String(int(1, 60)).padStart(2, "0")}`;
    if (used.has(id)) continue;
    used.add(id);
    const cmd = { id, role: "Commander", rank: pick(RANKS), name: r() < 0.1 ? "" : `Cmd ${id}` };
    // Most commanders are tagged to a platoon and file under its block; some
    // are coy-level and stay in COY HQ. Both must keep the block/rank sums
    // honest, and a commander may be tagged to a platoon holding no recruits.
    if (r() < 0.75) cmd.plt = String(int(1, 9));
    roster.push(cmd);
  }
  const anyId = () => roster.length ? pick(roster).id : "9999";
  const medical = [];
  for (let i = 0; i < int(0, 30); i++) {
    // ~1 in 12 records is an ORPHAN: a 4D with no roster row (a recruit who
    // left, or a sheet that drifted). It must still be filed, not dropped.
    const d4 = r() < 0.08 ? "8888" : anyId();
    const start = shift(int(-6, 1));
    const hasEnd = r() > 0.1;
    medical.push({
      id: 1000 + i, d4, status: pick(STATUSES), reason: pick(NASTY),
      startDate: disp(start), endDate: hasEnd ? disp(shift(int(-6, 8))) : "",
      inCamp: r() < 0.25, location: r() < 0.4 ? pick(NASTY) : ""
    });
  }
  const leave = [];
  for (let i = 0; i < int(0, 10); i++) {
    leave.push({
      id: 2000 + i, d4: anyId(), type: pick(LEAVE_TYPES), reason: pick(NASTY),
      startDate: disp(shift(int(-5, 0))), endDate: disp(shift(int(0, 6)))
    });
  }
  const appointments = [];
  for (let i = 0; i < int(0, 10); i++) {
    appointments.push({
      id: 3000 + i, d4: anyId(), date: disp(shift(int(-2, 40))), time: pick(TIMES),
      reason: pick(NASTY), location: r() < 0.5 ? pick(NASTY) : "",
      outOfCamp: r() < 0.4, resolved: r() < 0.15
    });
  }
  return { roster, medical, leave, appointments, attendance: [], customStatuses: [], msk: [] };
}

module.exports = async function run() {
  suite("parade format: property test over randomised, hostile states");

  await test("1000 random states all satisfy every format invariant", () => {
    const failures = [];
    for (let seed = 1; seed <= 1000; seed++) {
      const state = randomState(seed);
      let bundle, text, parsed;
      try {
        bundle = loadBundle(state);
        text = bundle.generateParadeStateText(seed % 2 ? "FP" : "LP", DATE, "0700");
        parsed = bundle.parseParadeState(text);
      } catch (e) {
        failures.push(`seed ${seed}: threw ${e && e.message}`);
        continue;
      }
      checkInvariants(text, parsed, state).forEach(v => failures.push(`seed ${seed}: ${v}`));

      // Generating the same state twice must give byte-identical text: the
      // report is copied, archived and diffed, so any instability (a Map that
      // iterates differently, a clock read) would show up as phantom changes
      // in tomorrow's compare.
      const again = bundle.generateParadeStateText(seed % 2 ? "FP" : "LP", DATE, "0700");
      if (again !== text) failures.push(`seed ${seed}: generation is not deterministic`);

      // …and a state diffed against ITSELF must report nothing. This is the
      // end-to-end proof that the parser is stable and the differ is not
      // inventing movements out of ordering or formatting.
      const self = bundle.diffParadeStates(parsed, bundle.parseParadeState(text), { oldText: text, newText: text });
      const noise = self.people.added.length + self.people.removed.length + self.people.changed.length;
      if (noise) failures.push(`seed ${seed}: self-diff reported ${noise} phantom changes`);
      if (self.warnings.length) failures.push(`seed ${seed}: self-diff warned ${JSON.stringify(self.warnings)}`);

      if (failures.length > 6) break;
    }
    ok(failures.length === 0, failures.slice(0, 6).join("\n         "));
  });

  suite("parade format: hostile free text can never break a line");

  const oneRecruit = extra => ({
    roster: [{ id: "1401", role: "Recruit", name: "Alpha One" }],
    medical: [Object.assign({
      id: 1, d4: "1401", status: "MC", startDate: disp(DATE), endDate: disp(shift(1)), inCamp: false
    }, extra)],
    leave: [], appointments: [], attendance: [], customStatuses: [], msk: []
  });

  await test("parentheses, @ and newlines survive as text, not as structure", () => {
    const b = loadBundle(oneRecruit({ reason: "Fever (38.5)\nrechecked", location: "Raffles @ Sembawang" }));
    const text = b.generateParadeStateText("FP", DATE, "0700");
    const rec = text.split("\n").filter(l => /^\d+\. /.test(l));
    eq(rec.length, 1, "one record, one line: " + JSON.stringify(rec));
    const parsed = b.parseParadeState(text);
    eq(parsed.unparsed.length, 0, "nothing unparsed: " + JSON.stringify(parsed.unparsed));
    eq(parsed.people[0].reason, "Fever 38.5 rechecked", "reason kept, brackets neutralised");
    eq(parsed.people[0].location, "Raffles at Sembawang", "location kept, @ neutralised");
    eq(parsed.people[0].statuses[0].family, "MC", "the status is still an MC");
  });

  await test("a reason that mimics the line format does not hijack it", () => {
    // "MC (extended) @ home" as a REASON must not be read as a status, a
    // location, or a second record.
    const b = loadBundle(oneRecruit({ reason: "MC (extended) @ home - 9999", location: "" }));
    const text = b.generateParadeStateText("FP", DATE, "0700");
    const parsed = b.parseParadeState(text);
    eq(parsed.people.length, 1, "still one person");
    eq(parsed.people[0].d4, "1401", "identity is the real 4D, not the one in the reason");
    eq(parsed.people[0].location, "", "no phantom location");
    eq(parsed.people[0].statuses[0].days, 2, "day count survives");
  });

  suite("parade format: degenerate rosters");

  await test("an empty roster still files a valid, zeroed state", () => {
    const b = loadBundle({ roster: [], medical: [], leave: [], appointments: [], attendance: [], customStatuses: [], msk: [] });
    const text = b.generateParadeStateText("FP", DATE, "0700");
    const v = checkInvariants(text, b.parseParadeState(text), { roster: [] });
    eq(v.length, 0, v.join(" | "));
    ok(/^COMPANY: 0\/0$/m.test(text), "zeroed company line");
    ok(/^COY HQ: 0\/0$/m.test(text), "COY HQ is always filed, even empty");
    ok(!/^PDS /m.test(text), "no platoons → no PDS lines");
  });

  await test("a record for someone no longer on the roster is still filed", () => {
    const st = {
      roster: [{ id: "1401", role: "Recruit", name: "Alpha One" }],
      medical: [{ id: 1, d4: "7777", status: "MC", reason: "Left the unit", startDate: disp(DATE), endDate: disp(shift(1)), inCamp: false }],
      leave: [], appointments: [], attendance: [], customStatuses: [], msk: []
    };
    const b = loadBundle(st);
    const text = b.generateParadeStateText("FP", DATE, "0700");
    eq(checkInvariants(text, b.parseParadeState(text), st).join(" | "), "", "invariants hold");
    ok(/^1\. 7777 - 2D MC \(Left the unit\)/m.test(text), "orphan record is filed under COY HQ: " + text);
    // …and it does NOT move the strength, which counts roster rows only.
    ok(/^COMPANY: 1\/1$/m.test(text), "orphan does not become a body");
  });

  await test("commanders with blank or unknown ranks still land in a bucket", () => {
    const st = {
      roster: [
        { id: "0001", role: "Commander", rank: "", name: "No Rank" },
        { id: "0002", role: "Commander", rank: "??", name: "Odd Rank" },
        { id: "0003", role: "Commander", rank: "2LT", name: "Officer" },
        { id: "0004", role: "Commander", rank: "3SG", name: "" }
      ],
      medical: [], leave: [], appointments: [], attendance: [], customStatuses: [], msk: []
    };
    const b = loadBundle(st);
    const text = b.generateParadeStateText("FP", DATE, "0700");
    eq(checkInvariants(text, b.parseParadeState(text), st).join(" | "), "", "invariants hold");
    ok(/^OFFICER: 1\/1$/m.test(text), "the 2LT is an officer");
    ok(/^WOSPEC: 3\/3$/m.test(text), "unknown/blank ranks fall back to WOSPEC");
  });
};
