// Parade-state generation tests (js/forms.js), focused on the consume-in-camp
// MC flag: such a recruit must (a) stay in CURRENT STRENGTH, (b) drop out of
// ATTC, and (c) appear under MEDICAL STATUS as "<N>D MC (consume in camp)",
// ordered by severity (above LD/Excuse). helpers.js + forms.js are loaded
// together (forms.js's parade generators call helpers.js functions); no DOM is
// needed for the text generators.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

function loadParade(state) {
  const sandbox = {
    STATE: state, console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat
  };
  vm.createContext(sandbox);
  const src = ["js/helpers.js", "js/forms.js"]
    .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n")
    + "\n;this.generateParadeStateText = generateParadeStateText;"
    // Expose the borderline-returnee override so tests can simulate the PDS
    // ticking a recently-ended MC as still-out.
    + "this.tickBorderline = d4 => { _paradeOverrides[d4] = true; };";
  vm.runInContext(src, sandbox, { filename: "parade-bundle.js" });
  return sandbox;
}

const DATE = "2026-06-29";
const state = () => ({
  roster: [
    { id: "1303", role: "Recruit", name: "Shuan Aaron Tan Yong Sheng" },
    { id: "1201", role: "Recruit", name: "Away Guy" },
    { id: "1405", role: "Recruit", name: "LD Guy" }
  ],
  medical: [
    // consume-in-camp MC (top severity) — should lead MEDICAL STATUS
    { d4: "1303", status: "MC", reason: "Fever", startDate: "29 Jun 2026", endDate: "30 Jun 2026", inCamp: true, location: "" },
    // ordinary away MC — the only ATTC entry
    { d4: "1201", status: "MC", reason: "Flu", startDate: "29 Jun 2026", endDate: "01 Jul 2026", inCamp: false, location: "" },
    // an LD to prove severity ordering within MEDICAL STATUS
    { d4: "1405", status: "LD", reason: "Ankle", startDate: "29 Jun 2026", endDate: "02 Jul 2026", location: "" }
  ],
  leave: [], appointments: [], attendance: [], customStatuses: []
});

// Pull out one labelled "SECTION: nn\n\n...blocks" chunk from the full report.
function section(text, label) {
  const parts = text.split(/\n-+\n/).map(s => s.trim());
  return parts.find(p => p.startsWith(label + ":")) || "";
}

module.exports = async function run() {
  suite("parade: consume-in-camp MC placement + strength");

  const txt = loadParade(state()).generateParadeStateText("FP", DATE, "0730");

  await test("CURRENT STRENGTH counts the consume-in-camp recruit present", () => {
    // 3 recruits, only the ordinary away MC (1201) is out → CURRENT = 2, TOTAL = 3.
    ok(/TOTAL STRENGTH: 3/.test(txt), "total is 3");
    ok(/CURRENT STRENGTH: 2/.test(txt), "current is 2 (only 1201 away)");
  });

  await test("ATTC lists only the ordinary away MC, not the in-camp one", () => {
    const attc = section(txt, "ATTC");
    ok(/C1201/.test(attc), "away MC in ATTC");
    ok(!/C1303/.test(attc), "consume-in-camp MC excluded from ATTC");
    ok(/ATTC: 01/.test(attc), "ATTC count is 1");
  });

  await test("MEDICAL STATUS shows '(consume in camp)' and sorts MC above LD", () => {
    const med = section(txt, "MEDICAL STATUS");
    ok(/Status: 2D MC \(consume in camp\)/.test(med), "in-camp MC labelled correctly");
    ok(/C1405/.test(med) && /Status: 4D LD/.test(med), "LD also listed");
    ok(med.indexOf("C1303") < med.indexOf("C1405"), "MC (sev 100) sorts above LD (sev 80)");
    ok(/MEDICAL STATUS: 02/.test(med), "two entries in MEDICAL STATUS");
  });

  suite("parade: a person is never in both ATTC and OTHERS");

  await test("active away MC + accidental book-out + leave → ATTC only", () => {
    // 1201 is genuinely away on MC AND was accidentally booked out AND put on
    // leave. outOfCampMap's medical precedence must keep them out of OTHERS.
    const st = state();
    const r = st.roster.find(x => x.id === "1201");
    r.outOfCamp = true; r.outSince = DATE;
    st.leave.push({ id: 1, d4: "1201", type: "Annual Leave", startDate: "29 Jun 2026", endDate: "30 Jun 2026", reason: "accidental" });
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/C1201/.test(section(out, "ATTC")), "on MC → ATTC");
    ok(!/C1201/.test(section(out, "OTHERS")), "accidental book-out/leave suppressed from OTHERS");
  });

  await test("borderline returnee (MC ended yesterday, ticked) + leave → ATTC only", () => {
    // 1201's MC ended the day before DATE, so it is INACTIVE — the PDS ticks
    // them still-out (folded into ATTC). They also have leave today, which
    // would otherwise leak them into OTHERS since medical precedence no longer
    // applies to an inactive record.
    const st = state();
    st.medical.find(m => m.d4 === "1201").endDate = "28 Jun 2026"; // ended yesterday
    st.leave.push({ id: 2, d4: "1201", type: "Annual Leave", startDate: "29 Jun 2026", endDate: "30 Jun 2026", reason: "x" });
    const bundle = loadParade(st);
    bundle.tickBorderline("1201");
    const out = bundle.generateParadeStateText("FP", DATE, "0730");
    ok(/C1201/.test(section(out, "ATTC")), "ticked borderline returnee is in ATTC");
    ok(!/C1201/.test(section(out, "OTHERS")), "not double-listed in OTHERS");
  });

  // ── Back-to-back re-issues ───────────────────────────────
  // An extended MC / a second block of leave is a NEW record starting the day
  // after the last one ends. Reporting the covering record's own end date told
  // the chat the recruit was back days before they actually are.
  suite("parade: chained statuses report the whole run");

  await test("ATTC states the extended MC's real end date and total days", () => {
    const st = state();
    // 1201's away MC is 29 Jun – 01 Jul; extend it with a second record.
    st.medical.push({ d4: "1201", status: "MC", reason: "Flu", startDate: "02 Jul 2026", endDate: "04 Jul 2026", inCamp: false, location: "" });
    const attc = section(loadParade(st).generateParadeStateText("FP", DATE, "0730"), "ATTC");
    ok(/Status: 6D MC \(extended\)/.test(attc), "6 days across both records: " + attc);
    ok(/Duration: 290626 - 040726/.test(attc), "duration spans the run: " + attc);
    ok(!/010726\b(?! -)/.test(attc.split("Duration:")[1] || ""), "no stray first-record end");
  });

  await test("a genuine gap is NOT merged into one run", () => {
    const st = state();
    // Back in camp 02–03 Jul, then a fresh MC — today's absence still ends 01 Jul.
    st.medical.push({ d4: "1201", status: "MC", reason: "Flu", startDate: "04 Jul 2026", endDate: "05 Jul 2026", inCamp: false, location: "" });
    const attc = section(loadParade(st).generateParadeStateText("FP", DATE, "0730"), "ATTC");
    ok(/Status: 3D MC$/m.test(attc), "unchanged 3D MC: " + attc);
    ok(/Duration: 290626 - 010726/.test(attc), "ends at the real return: " + attc);
  });

  await test("OTHERS spans back-to-back leave of the same type", () => {
    const st = state();
    st.leave.push(
      { id: 11, d4: "1405", type: "Annual Leave", startDate: "29 Jun 2026", endDate: "30 Jun 2026", reason: "family" },
      { id: 12, d4: "1405", type: "Annual Leave", startDate: "01 Jul 2026", endDate: "02 Jul 2026", reason: "family" }
    );
    const others = section(loadParade(st).generateParadeStateText("FP", DATE, "0730"), "OTHERS");
    ok(/Duration: 290626 - 020726/.test(others), "leave run merged: " + others);
  });

  await test("strength still counts each body once across a run", () => {
    const st = state();
    st.medical.push({ d4: "1201", status: "MC", reason: "Flu", startDate: "02 Jul 2026", endDate: "04 Jul 2026", inCamp: false, location: "" });
    const out = loadParade(st).generateParadeStateText("FP", DATE, "0730");
    ok(/CURRENT STRENGTH: 2/.test(out), "still 2 present, chaining is display-only");
  });
};
