// Spelling-tolerant medical statuses (canonMedStatus / medStatusKey in
// js/helpers.js, applied at the read boundary by normalizeMedical).
//
// Custom statuses are free-typed on different phones, and the live data had
// grown "Excuse Boots" next to "Excuse boots", four spellings of the live /
// blank firing excuse, "excuse push-ups" next to "excuse pushups", and so on -
// each one its own slice of the status chart and its own parade line. The
// spellings below are the real variants that were in the medical table.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

function load(customStatuses = []) {
  const store = new Map();
  const sandbox = {
    console, Math, Date, JSON, String, Number, Array, Object, Boolean, RegExp,
    Set, Map, isNaN, parseInt, parseFloat,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  vm.createContext(sandbox);
  ["js/helpers.js", "js/state.js"].forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f }));
  sandbox.__custom = customStatuses;
  vm.runInContext("STATE.customStatuses = __custom; STATE.medical = [];", sandbox);
  return sandbox;
}

const rec = (status, i) => ({ id: "m" + i, d4: "1101", status });
const statusesOf = (b, list) => b.normalizeMedical(list.map(rec)).map(r => r.status);
const distinct = arr => [...new Set(arr)];

module.exports = async function run() {
  suite("statuses: near-duplicate spellings fold onto one name");

  const groups = [
    ["Excuse Boots", "Excuse boots", "Excuse Boots"],
    ["Excuse Boots and Shoes", "excused shoes and boots"],
    ["Excuse Camo", "Excuse camo", "Excuse Camo"],
    ["Excuse Grenade and Explosives", "Excuse Grenades & Explosives", "Excuse from Grenade & Explosives", "Excuse Grenades and Explosives"],
    ["Excuse Live Firing, Firing of Blanks", "Excuse Live Firing, Firing of Blanks", "Excuse from Live Firing, Blank Firing",
     "Excuse Live Firing and Blanks Firing", "Excuse Live Firing and Firing of Blanks", "Excuse live/blank firing"],
    ["excuse push-ups", "excuse pushups"],
    ["Excuse Stay In", "Excuse Stay In", "Excuse Stay-in", "Stay in"],
    ["Excuse from Sharps", "Excuse Sharps", "Excuse Sharps"],
    ["excuse marching", "marching"],
  ];
  for (const g of groups) {
    await test(`one name for: ${distinct(g).join(" / ")}`, () => {
      eq(distinct(statusesOf(load(), g)).length, 1, "folded to a single status");
    });
  }

  await test("the most-used spelling wins, so every device picks the same one", () => {
    eq(distinct(statusesOf(load(), ["Excuse boots", "Excuse Boots", "Excuse Boots"])), ["Excuse Boots"]);
    eq(distinct(statusesOf(load(), ["Excuse Stay-in", "Stay in", "Excuse Stay In", "Excuse Stay In"])), ["Excuse Stay In"]);
  });

  suite("statuses: one spelling convention");

  await test("custom names are 'Excuse' + Title Case", () => {
    eq(distinct(statusesOf(load(), ["excuse pushups", "excuse pushups", "excuse push-ups"])), ["Excuse Pushups"]);
    eq(distinct(statusesOf(load(), ["excused shoes and boots"])), ["Excuse Shoes and Boots"]);
    eq(distinct(statusesOf(load(), ["excuse headgear"])), ["Excuse Headgear"]);
    eq(distinct(statusesOf(load(), ["marching", "excuse marching"])), ["Excuse Marching"]);
  });

  await test("acronyms stay in capitals, small words stay lower-case", () => {
    const b = load();
    eq(b.medStatusTitle("Excuse FLEGS"), "Excuse FLEGS");
    eq(b.medStatusTitle("excuse handling OF firearms"), "Excuse Handling of Firearms");
    eq(b.medStatusTitle("Excuse stay-in"), "Excuse Stay-In");
    eq(b.medStatusTitle("RIB"), "RIB");
  });

  await test("case variants pool their count before the vote", () => {
    // 2 + 2 of the lower-case wording beats 3 of another one.
    eq(distinct(statusesOf(load(), ["excuse camo", "Excuse camo", "Excuse Camo", "Excuse Camo", "Excuse Camos", "Excuse Camos", "Excuse Camos"])), ["Excuse Camo"]);
  });

  suite("statuses: live firing and blank firing are two excuses");

  await test("both are built-in Excuses that own their spellings", () => {
    const b = load();
    const all = vm.runInContext("MED_STATUSES", b);
    ok(all.includes("Excuse Live Firing") && all.includes("Excuse Blank Firing"), "selectable");
    eq(statusesOf(b, ["excuse live firing", "Excuse Blanks Firing", "Excuse Firing of Blanks", "excused blank firing"]),
       ["Excuse Live Firing", "Excuse Blank Firing", "Excuse Blank Firing", "Excuse Blank Firing"]);
  });

  await test("every combined spelling splits into the two", () => {
    const b = load();
    ["Excuse Live Firing, Firing of Blanks", "Excuse from Live Firing, Blank Firing", "Excuse Live Firing and Blanks Firing",
     "Excuse Live Firing and Firing of Blanks", "Excuse live/blank firing", "Excuse Live and Blank Firing"]
      .forEach(v => eq(b.medStatusSplit(v), ["Excuse Live Firing", "Excuse Blank Firing"], v));
  });

  await test("a single status does not split", () => {
    const b = load();
    eq(b.medStatusSplit("Excuse Live Firing"), ["Excuse Live Firing"]);
    eq(b.medStatusSplit("Excuse Blank Firing"), ["Excuse Blank Firing"]);
    eq(b.medStatusSplit("MC"), ["MC"]);
  });

  await test("a combined status is never saved as a custom status", () => {
    const b = load();
    b.addCustomStatus("Excuse live/blank firing", false);
    eq(vm.runInContext("STATE.customStatuses.length", b), 0);
  });

  await test("a variant of a built-in Excuse becomes the built-in", () => {
    eq(distinct(statusesOf(load(), ["excuse heavy loads", "Excuse  Heavy Load", "Excused Kneeling"])).sort(),
       ["Excuse Heavy Load", "Excuse Kneeling"]);
  });

  suite("statuses: different statuses stay apart");

  await test("RMJ and Excuse RMJ are not merged", () => {
    eq(statusesOf(load(), ["RMJ", "Excuse RMJ", "rmj"]), ["RMJ", "Excuse RMJ", "RMJ"]);
  });

  await test("built-ins match on their name in any case", () => {
    eq(statusesOf(load(), ["mc", "LD", "ld", "Warded", "nil", "pending"]), ["MC", "LD", "LD", "Warded", "NIL", "Pending"]);
  });

  await test("statuses that only share a word stay separate", () => {
    const real = ["Excuse Boots", "Excuse Boots and Shoes", "Excuse Covered Shoes", "Excuse Camo", "Excuse Camo Cream",
      "excuse headgear", "excuse helmet", "Excuse Upper Limb", "Excuse Lower Limb", "Excuse Handling of Firearms",
      "Excuse Field Training", "Excuse Jumping", "Excuse Proning", "Excuse Leopard Crawl", "Excuse Loud Noise", "RIB"];
    eq(distinct(statusesOf(load(), real)).length, real.length, "nothing merged");
  });

  await test("hospitalisation leave keeps its own fold", () => {
    eq(statusesOf(load(), ["Hospitalization Leave"]), ["Hospitalisation Leave"]);
  });

  suite("statuses: saved custom statuses");

  await test("a saved custom status is found under another spelling", () => {
    const b = load([{ name: "Excuse Boots", participates: true }]);
    const c = b.customStatusByName("excused boot");
    ok(c && c.name === "Excuse Boots", "matched the saved status");
    eq(b.statusParticipates("Excuse boots"), true, "its participates flag applies");
  });

  await test("re-saving a near-duplicate updates the existing entry", () => {
    const b = load([{ name: "Excuse Boots", participates: false }]);
    b.addCustomStatus("excuse boots", true);
    const list = vm.runInContext("STATE.customStatuses", b);
    eq(list.length, 1, "no second entry");
    eq(list[0].participates, true, "flag updated");
  });

  await test("this phone's saved spelling never outvotes the data", () => {
    // Custom statuses are per-device; if they voted, two phones could show the
    // same records under different names.
    const b = load([{ name: "excuse boots", participates: false }]);
    vm.runInContext("STATE.medical = normalizeMedical([{ id: 'm1', d4: '1101', status: 'Excuse Boots' }]);", b);
    eq(b.canonMedStatus("excuse boots"), "Excuse Boots");
  });
};
