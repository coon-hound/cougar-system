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
    + "\n;this.generateParadeStateText = generateParadeStateText;";
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
};
