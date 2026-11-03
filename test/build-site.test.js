// scripts/build-site.mjs: the deploy step that stamps ?v= and gathers notes.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const SCRIPT = pathToFileURL(path.join(__dirname, "..", "scripts", "build-site.mjs")).href;
const throwsLike = (fn, re) => {
  try { fn(); } catch (e) { ok(re.test(String(e.message)), `error ${JSON.stringify(e.message)} should match ${re}`); return; }
  throw new Error(`expected a throw matching ${re}`);
};

module.exports = async () => {
  const B = await import(SCRIPT);
  suite("build-site: cache-buster stamp and patch notes");

  await test("stamps every ?v=dev with the deploy version", () => {
    const html = `<link href="styles.css?v=dev"><script src="js/a.js?v=dev"></script><script src="js/b.js?v=dev"></script>`;
    const r = B.stampVersion(html, "57");
    eq(r.count, 3);
    ok(!r.html.includes("v=dev") && (r.html.match(/\?v=57"/g) || []).length === 3, r.html);
  });

  await test("refuses a hand-set number left in index.html", () => {
    throwsLike(() => B.stampVersion(`<script src="js/a.js?v=dev"></script><script src="js/b.js?v=171"></script>`, "57"), /hand-set \?v=171/);
  });

  await test("refuses a page with nothing to stamp, or a non-version", () => {
    throwsLike(() => B.stampVersion(`<script src="js/a.js"></script>`, "57"), /no \?v=dev/);
    throwsLike(() => B.stampVersion(`<script src="js/a.js?v=dev"></script>`, "dev"), /not a deployable/);
    throwsLike(() => B.stampVersion(`<script src="js/a.js?v=dev"></script>`, ""), /not a deployable/);
  });

  await test("notes are collected newest first, by file name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cougar-notes-"));
    try {
      const w = (f, n) => fs.writeFileSync(path.join(dir, f), JSON.stringify(n));
      w("2026-11-02-ippt-card.json", { date: "2 Nov 2026", title: "B", items: ["x"] });
      w("2026-11-10-picker.json", { date: "10 Nov 2026", title: "C", intro: "i", items: [{ t: "t", d: "d" }] });
      w("2026-10-30-older.json", { date: "30 Oct 2026", title: "A", items: ["y"] });
      w("index.json", []);
      const notes = B.collectNotes(dir);
      eq(notes.map((n) => n.id), ["2026-11-10-picker", "2026-11-02-ippt-card", "2026-10-30-older"]);
      eq(notes[0], { id: "2026-11-10-picker", date: "10 Nov 2026", title: "C", intro: "i", items: [{ t: "t", d: "d" }] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test("a malformed note fails the deploy and names the file", () => {
    throwsLike(() => B.parseNote("ippt.json", `{"date":"2 Nov 2026","title":"T","items":["x"]}`), /ippt\.json: name it/);
    throwsLike(() => B.parseNote("2026-11-02-a.json", `{"date":"2 Nov 2026","items":["x"]}`), /2026-11-02-a\.json: needs a "title"/);
    throwsLike(() => B.parseNote("2026-11-02-a.json", `{"date":"2 Nov 2026","title":"T","items":[]}`), /non-empty "items"/);
    throwsLike(() => B.parseNote("2026-11-02-a.json", `{"date":"2 Nov 2026","title":"T","items":[{"d":"no title"}]}`), /item 1/);
    throwsLike(() => B.parseNote("2026-11-02-a.json", `{nope`), /not valid JSON/);
  });

  await test("every note committed in notes/ is valid", () => {
    B.collectNotes(path.join(__dirname, "..", "notes"));
  });
};
