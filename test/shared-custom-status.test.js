// Custom statuses are shared across phones by deriving the list from the
// medical records every phone syncs (sharedCustomStatuses in js/helpers.js),
// so a status saved on one phone is offered on every other one and nobody
// types a near-duplicate of it.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

// A phone with its own saved list (`local`) that has synced `medical`.
function phone(medical, local = []) {
  const store = new Map();
  const sandbox = {
    console, Math, Date, JSON, String, Number, Array, Object, Boolean, RegExp,
    Set, Map, isNaN, parseInt, parseFloat,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  };
  vm.createContext(sandbox);
  ["js/helpers.js", "js/state.js"].forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f }));
  sandbox.__med = medical; sandbox.__local = local;
  vm.runInContext("STATE.customStatuses = __local; STATE.medical = normalizeMedical(__med);", sandbox);
  return sandbox;
}

const rec = (id, status, over = {}) => Object.assign({ id, d4: "1101", status, startDate: "01 Nov 2026", endDate: "05 Nov 2026" }, over);
const names = b => b.sharedCustomStatuses().map(c => c.name);

module.exports = async function run() {
  suite("custom statuses: shared through the synced records");

  await test("a status saved on another phone is offered here", () => {
    const b = phone([rec("a", "Excuse Boots", { participates: true })]);
    eq(b.sharedCustomStatuses(), [{ name: "Excuse Boots", participates: true }]);
  });

  await test("built-ins and the combined firing status never appear as custom", () => {
    const b = phone([rec("a", "MC"), rec("b", "Excuse RMJ"), rec("c", "RMJ"), rec("d", "Excuse live/blank firing"), rec("e", "Excuse Camo")]);
    eq(names(b), ["Excuse Camo"]);
  });

  await test("spelling variants across phones are one entry", () => {
    const b = phone([rec("a", "Excuse Boots"), rec("b", "excuse boots"), rec("c", "Excuse Boot")], [{ name: "excused boots", participates: false }]);
    eq(names(b), ["Excuse Boots"]);
  });

  await test("a one-off status is not offered, but still resolves for its record", () => {
    const b = phone([rec("a", "Excuse Loud Noise", { oneOff: true, participates: true })]);
    eq(names(b), []);
    ok(b.customStatusByName("Excuse Loud Noise"), "badge / severity still know it");
    eq(b.statusParticipates("Excuse Loud Noise"), true);
  });

  await test("a one-off that someone else saved for reuse is offered", () => {
    const b = phone([rec("a", "Excuse Loud Noise", { oneOff: true }), rec("b", "Excuse Loud Noise")]);
    eq(names(b), ["Excuse Loud Noise"]);
  });

  await test("participates: the newest record that says wins, on every phone", () => {
    const med = [
      rec("a", "Excuse Boots", { participates: false, startDate: "01 Oct 2026" }),
      rec("b", "Excuse Boots", { participates: true, startDate: "01 Nov 2026" }),
      rec("c", "Excuse Boots", { startDate: "10 Nov 2026" }) // older-format row, no flag
    ];
    eq(phone(med).statusParticipates("Excuse Boots"), true);
    eq(phone(med, [{ name: "Excuse Boots", participates: false }]).statusParticipates("Excuse Boots"), true,
       "a phone's own old setting does not override the shared one");
  });

  await test("records from before the flag fall back to this phone's setting, else not participating", () => {
    eq(phone([rec("a", "Excuse Boots")], [{ name: "Excuse Boots", participates: true }]).statusParticipates("Excuse Boots"), true);
    eq(phone([rec("a", "Excuse Boots")]).statusParticipates("Excuse Boots"), false);
  });

  await test("a status saved on this phone shows before any record carries it", () => {
    const b = phone([]);
    b.addCustomStatus("excuse helmet", true);
    eq(b.sharedCustomStatuses(), [{ name: "Excuse Helmet", participates: true }]);
  });

  await test("the flags survive the text round-trip", () => {
    const b = phone([]);
    eq(b.normalizeMedical([{ id: "x", participates: "TRUE", oneOff: "true" }, { id: "y", participates: "false" }, { id: "z" }])
      .map(r => [r.participates, r.oneOff]), [[true, true], [false, false], ["", false]]);
  });
};
