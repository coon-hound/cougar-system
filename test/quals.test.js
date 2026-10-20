// Unit tests for secondary roles + qualifications (js/helpers.js): the
// comma/@date string they are stored as, expiry state, and who holds what.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

function loadHelpers(state) {
  const sandbox = {
    STATE: state, console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js/helpers.js"), "utf8"), sandbox, { filename: "helpers.js" });
  return sandbox;
}

const plain = v => JSON.parse(JSON.stringify(v));

module.exports = async function run() {
  suite("quals: storage format, expiry, holders");

  const h = loadHelpers({ roster: [
    { id: "0001", role: "Commander", quals: "Range Safety Officer" },
    { id: "1101", role: "Recruit", quals: "CPR@2026-11-30, Class 3 Licence", secondaryRoles: "Medic, Runner" },
    { id: "1102", role: "Recruit", quals: "CPR@2026-10-01" },
    { id: "1103", role: "Recruit", quals: "" }
  ] });

  await test("a qual with and without an expiry parses", () => {
    eq(plain(h.getQuals(h.STATE.roster[1])), [{ name: "CPR", expires: "2026-11-30" }, { name: "Class 3 Licence", expires: "" }]);
    eq(plain(h.getQuals({})), []);
  });

  await test("an @ that is not a date stays part of the name", () => {
    eq(plain(h.getQuals({ quals: "Range @ Pasir Laba" })), [{ name: "Range @ Pasir Laba", expires: "" }]);
  });

  await test("serialize round-trips, and a re-award replaces the old expiry", () => {
    const r = { quals: "CPR@2026-11-30, Class 3 Licence" };
    eq(h.serializeQuals(h.getQuals(r)), "CPR@2026-11-30, Class 3 Licence");
    eq(h.serializeQuals([{ name: "CPR", expires: "2026-01-01" }, { name: " CPR ", expires: "2027-01-01" }, { name: "", expires: "x" }]), "CPR@2027-01-01");
  });

  await test("qualState: no expiry is valid; 30 days left is expiring; 31 is valid; yesterday is expired", () => {
    eq(h.qualState({ name: "X", expires: "" }, "2026-10-20"), "valid");
    eq(h.qualState({ name: "X", expires: "2026-11-19" }, "2026-10-20"), "expiring");
    eq(h.qualState({ name: "X", expires: "2026-11-20" }, "2026-10-20"), "valid");
    eq(h.qualState({ name: "X", expires: "2026-10-20" }, "2026-10-20"), "expiring");
    eq(h.qualState({ name: "X", expires: "2026-10-19" }, "2026-10-20"), "expired");
  });

  await test("qualHolders covers commanders and rates each holder on the date", () => {
    eq(h.qualHolders("Range Safety Officer", "2026-10-20").map(x => x.r.id), ["0001"]);
    eq(h.qualHolders("CPR", "2026-10-20").map(x => [x.r.id, x.state]), [["1101", "valid"], ["1102", "expired"]]);
  });

  await test("names in use are collected, sorted and de-duplicated", () => {
    eq(plain(h.allQualNames()), ["Class 3 Licence", "CPR", "Range Safety Officer"]);
    eq(plain(h.allSecondaryRoleNames()), ["Medic", "Runner"]);
  });

  await test("a name carrying a storage delimiter is refused", () => {
    ok(h.tagNameOk("CPR") && !h.tagNameOk("CPR, AED") && !h.tagNameOk("CPR@x") && !h.tagNameOk(""));
  });
};
