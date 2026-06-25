// Test entry point: runs every *.test.js in test/ sequentially, prints a
// summary, and exits non-zero if anything failed (so CI goes red).
const fs = require("fs");
const path = require("path");
const { summary } = require("./_tap");

(async () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".test.js"))
    .sort();   // backend.test.js, static.test.js, sync.test.js — order doesn't matter
  for (const f of files) {
    const run = require(path.join(dir, f));
    if (typeof run === "function") await run();
  }
  process.exit(summary());
})().catch(e => { console.error(e); process.exit(1); });
