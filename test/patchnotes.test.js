// js/patchnotes.js: which "What's New" notes a device is shown.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { suite, test, eq } = require("./_tap");

module.exports = async () => {
  const ctx = {};
  vm.createContext(ctx);
  // Top-level const/function declarations land in the context's global scope;
  // expose the one under test explicitly.
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "patchnotes.js"), "utf8") + "\n;this.pick = pickPatchNotes; this.legacy = PATCH_NOTES;", ctx);
  const { pick } = ctx;
  const legacy = [{ v: 172, title: "L172" }, { v: 171, title: "L171" }, { v: 170, title: "L170" }];
  const fresh = [{ id: "2026-11-10-b", title: "B" }, { id: "2026-11-03-a", title: "A" }];
  const titles = (xs) => xs.map((n) => n.title);

  suite("patch notes: which ones a device sees");

  await test("a brand-new device sees only the newest note", () => {
    eq(titles(pick(legacy, fresh, null, null)), ["B"]);
    eq(titles(pick(legacy, [], null, null)), ["L172"]);
  });

  await test("a device up to date on the old numbering sees every new note", () => {
    eq(titles(pick(legacy, fresh, 172, null)), ["B", "A"]);
  });

  await test("notes already seen are not shown again", () => {
    eq(titles(pick(legacy, fresh, 172, ["2026-11-03-a"])), ["B"]);
    eq(titles(pick(legacy, fresh, 172, ["2026-11-03-a", "2026-11-10-b"])), []);
  });

  await test("a device behind on the old numbering still gets what it missed", () => {
    eq(titles(pick(legacy, fresh, 170, [])), ["B", "A", "L172", "L171"]);
  });

  await test("the frozen history is newest first and every entry is numbered", () => {
    const vs = ctx.legacy.map((n) => n.v);
    eq(vs.every((v) => Number.isInteger(v)), true);
    eq(vs, vs.slice().sort((a, b) => b - a));
  });
};
