// Static load-time guards — catch the failure class that twice reached prod:
//  (a) a duplicate top-level const across scripts that threw on load and blanked
//      the dashboard, and (b) a write path that forgot to bump the revision.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { suite, test, ok } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const REV_TABS = ["Roster", "Medical", "Attendance", "IPPT", "RouteMarch", "SOC",
  "PolarFlow", "ConductDetail", "Appointments", "Leave", "MSK", "Conducts"];

module.exports = async function run() {
  suite("static: load-time guards");

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  // All local <script src="js/....js?v=NN"> in document order.
  const scriptRe = /<script\s+src="(js\/[^"?]+)(?:\?v=(\d+))?"><\/script>/g;
  const scripts = [];
  let m;
  while ((m = scriptRe.exec(html)) !== null) scripts.push({ src: m[1], v: m[2] });

  await test("found the frontend scripts in index.html", () => {
    ok(scripts.length >= 6, "expected several js/*.js script tags, got " + scripts.length);
  });

  // (a) Concatenate all scripts in load order and COMPILE as one program — this
  // reproduces the browser's shared global lexical scope, so a duplicate top-level
  // `const`/`let` across files (the STATE_TO_TAB blank-dashboard bug) is an early
  // SyntaxError here. Compile-only: never executes, so browser globals are fine.
  await test("all scripts parse together (no duplicate top-level declarations)", () => {
    const bundle = scripts.map(s => fs.readFileSync(path.join(ROOT, s.src), "utf8")).join("\n;\n");
    new vm.Script(bundle, { filename: "bundle.js" }); // throws on dup const/let or syntax error
  });

  // (b) Every local script must share one cache-busting ?v=NN — a mismatch ships
  // partly-stale JS (e.g. new index.html + old cached api.js).
  await test("all script tags use the same ?v= cache version", () => {
    const versions = [...new Set(scripts.map(s => s.v))];
    ok(scripts.every(s => s.v), "every js script has a ?v= version: " + JSON.stringify(scripts.map(s => s.src + "?v=" + s.v)));
    ok(versions.length === 1, "expected one version across all scripts, found: " + JSON.stringify(versions));
  });

  suite("static: no unbumped tracked-tab writes (heuristic)");

  // (c) Heuristic lint: any DIRECT write primitive called with a tracked-tab
  // STRING LITERAL (i.e. bypassing doPost's withRevLock, which passes `tab` as a
  // variable) must have a bumpRev("<sameTab>") within a few lines — otherwise the
  // change silently misses every client's revCheck (the Telegram leak class).
  await test("direct tracked-tab writes are followed by a bumpRev", () => {
    const gs = fs.readFileSync(path.join(ROOT, "apps-script-Code.gs"), "utf8").split("\n");
    const callRe = /\b(appendRow|appendMany|upsertRow|writeTab|deleteRowById|updateRow)\(\s*"([A-Za-z]+)"/;
    const offenders = [];
    for (let i = 0; i < gs.length; i++) {
      const mm = gs[i].match(callRe);
      if (!mm) continue;
      const tab = mm[2];
      if (REV_TABS.indexOf(tab) === -1) continue;        // untracked tab → irrelevant
      const windowText = gs.slice(i, i + 16).join("\n");  // look ahead (multi-line literal + comments)
      const bumped = new RegExp('bumpRev\\(\\s*"' + tab + '"').test(windowText)
        || /withRevLock\(/.test(gs.slice(Math.max(0, i - 3), i + 1).join("\n"));
      if (!bumped) offenders.push((i + 1) + ": " + gs[i].trim());
    }
    ok(offenders.length === 0, "tracked-tab writes missing a nearby bumpRev:\n   " + offenders.join("\n   "));
  });

  suite("static: lock-domain split (script lock is Telegram-only)");

  const gsText = fs.readFileSync(path.join(ROOT, "apps-script-Code.gs"), "utf8");
  const gsLines = gsText.split("\n");

  // (d) The Telegram poller holds the SCRIPT lock for up to 5 minutes. Data
  // writes therefore use the DOCUMENT lock (getDataLock). If getScriptLock ever
  // reappears in data-path code, a save can queue behind a 5-minute poll — the
  // production "Server busy, please retry" storm. Structural rule: every
  // getScriptLock call site must live BELOW the Telegram section banner.
  await test("every getScriptLock call is inside the Telegram section", () => {
    const banner = gsLines.findIndex(l => l.includes("TELEGRAM REPORT-SICK (RSO) BOT"));
    ok(banner > 0, "Telegram section banner found");
    const offenders = [];
    gsLines.forEach((l, i) => {
      if (l.includes("getScriptLock") && i < banner) offenders.push((i + 1) + ": " + l.trim());
    });
    ok(offenders.length === 0, "getScriptLock above the Telegram banner (data path!):\n   " + offenders.join("\n   "));
  });

  // (e) Belt-and-suspenders: getDataLock must hand out the document lock and
  // must NOT quietly fall back to the script lock (the old fallback silently
  // reintroduced poller-vs-write contention whenever the doc lock was null).
  await test("getDataLock uses the document lock with no script-lock fallback", () => {
    const mBody = gsText.match(/function getDataLock\(\)\s*{([\s\S]*?)\n}/);
    ok(mBody, "getDataLock found");
    ok(mBody[1].includes("getDocumentLock"), "uses getDocumentLock");
    ok(!mBody[1].includes("getScriptLock"), "no script-lock fallback");
  });

  suite("static: deploy observability");

  // (f) BACKEND_BUILD makes the live deployment identifiable (curl ping). It
  // must exist in date-counter form and be stamped by jsonResponse — otherwise
  // "which code is Version N running" becomes unanswerable again.
  await test("BACKEND_BUILD exists and jsonResponse stamps it", () => {
    ok(/var BACKEND_BUILD = "\d{4}-\d{2}-\d{2}-\d+"/.test(gsText), "BACKEND_BUILD constant in date-counter form");
    const mResp = gsText.match(/function jsonResponse\(obj\)\s*{([\s\S]*?)\n}/);
    ok(mResp && mResp[1].includes("BACKEND_BUILD"), "jsonResponse references BACKEND_BUILD");
  });

  // (g) Every mutating doPost dispatch must run under withRevLock — a branch
  // that skips it writes without atomicity or a rev bump.
  await test("every mutating doPost branch is wrapped in withRevLock", () => {
    const mutating = ["write", "append", "appendMany", "upsertRow", "applyOps", "deleteRowById", "deleteRow", "updateRow"];
    const offenders = [];
    gsLines.forEach((l, i) => {
      const mm = l.match(/action === "([A-Za-z]+)"/);
      if (!mm || mutating.indexOf(mm[1]) === -1) return;
      // The dispatch assignment may sit a few lines below the branch condition
      // (comment lines in between).
      const windowText = gsLines.slice(i, i + 10).join("\n");
      if (!/withRevLock\(/.test(windowText)) offenders.push((i + 1) + ": " + l.trim());
    });
    ok(offenders.length === 0, "mutating branches without withRevLock:\n   " + offenders.join("\n   "));
  });
  suite("static: row ids are TEXT, and inline handlers quote them");

  // Row ids used to be numbers on the Sheets backend and are strings on the
  // Postgres one (normId, js/state.js). Two mechanical consequences, both of
  // which reached prod as silent bugs and both of which a grep can hold:

  // (d) `+gv("f-entry-id")` is how an edit turned into an APPENDED DUPLICATE:
  // `+"1404"` is a truthy 1404 that then fails `===` against the row's text id,
  // so submitMedical fell through its edit branch. Every editId read must take
  // the field's value as the string it is.
  await test("no submit handler coerces the edit id with +", () => {
    const forms = fs.readFileSync(path.join(ROOT, "js/forms.js"), "utf8");
    const offenders = forms.split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /[+]\s*gv\(\s*["']f-entry-id["']\s*\)/.test(line));
    ok(offenders.length === 0,
      'f-entry-id must be read as text (gv(...).trim()), never +gv(...): ' +
      JSON.stringify(offenders));
  });

  // (e) An inline handler that interpolates a row id UNQUOTED — onclick=
  // "openMedicalForm(${m.id})" — was fine while ids were numbers and is a
  // ReferenceError the moment one is the string "1404" or "m9k2x1-...". 20 of
  // these had to be quoted; this stops the 21st.
  await test("every row id interpolated into an inline handler is quoted", () => {
    // Staged Polar groups are the deliberate exception: their ids come from a
    // local UI counter (++_polarGroupCounter), are never persisted, and stay
    // numeric. Anything else with an id in an inline handler is a real row id.
    const NUMERIC_BY_DESIGN = /^(removePolarPhotoFromGroup|removePolarGroup|updatePolarGroup|addPolarPhotosToGroup)$/;
    const offenders = [];
    for (const file of ["js/render.js", "js/forms.js", "js/helpers.js"]) {
      const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const handlerRe = /\bon[a-z]+="([^"]*)"/g;
        let h;
        while ((h = handlerRe.exec(line)) !== null) {
          const body = h[1];
          const callRe = /([A-Za-z_$][\w$]*)\(([^)]*)\)/g;
          let c;
          while ((c = callRe.exec(body)) !== null) {
            const [, fn, args] = c;
            if (NUMERIC_BY_DESIGN.test(fn)) continue;
            const argRe = /(.?)(\$\{[^}]*\bid\b[^}]*\})(.?)/g;
            let a;
            while ((a = argRe.exec(args)) !== null) {
              const quoted = a[1] === "'" && a[3] === "'";
              if (!quoted) offenders.push(`${file}:${i + 1} ${fn}(${a[2]})`);
            }
          }
        }
      });
    }
    ok(offenders.length === 0,
      "unquoted id interpolation in an inline handler — a string id throws " +
      "ReferenceError there: " + JSON.stringify(offenders, null, 1));
  });

  await test("the unit suite stays runnable with no node_modules", () => {
    // .github/workflows/test.yml runs `node test/run.js` WITHOUT `npm install`,
    // on purpose: a dependency-free gate is fast and cannot be broken by a bad
    // lockfile. That guarantee is easy to lose by accident — a unit test
    // imports a script to reach its pure helpers, and that script imports an
    // npm package at the top level. It passes locally, where node_modules
    // exists, and fails only in CI with ERR_MODULE_NOT_FOUND.
    //
    // That is exactly how scripts/issue-invites.mjs broke the job: it imported
    // `postgres` at the top, so merely importing the module for padD4 pulled in
    // a package CI never installs. The fix was a lazy import inside main().
    //
    // So: nothing reachable from a unit test may import a bare package
    // specifier at the top level. Node builtins (node:*) and relative paths
    // are fine.
    const bareImport = /^\s*(?:import\s[^;]*?from\s*|import\s*)["']([^."'][^"']*)["']/gm;
    const isNpm = (spec) => !spec.startsWith("node:") && !spec.startsWith(".");

    // Every unit test, plus every local module they pull in.
    const reachable = new Set();
    const testFiles = fs.readdirSync(path.join(ROOT, "test"))
      .filter((f) => f.endsWith(".test.js"))
      .map((f) => path.join("test", f));
    for (const t of testFiles) {
      reachable.add(t);
      const src = fs.readFileSync(path.join(ROOT, t), "utf8");
      // Two shapes are used in this repo, and BOTH must be followed:
      //   import("../scripts/x.mjs")                     — a relative specifier
      //   path.join(ROOT, "scripts/x.mjs")               — a repo-relative
      //     string handed to pathToFileURL, which is how the ESM script tests
      //     actually do it. Missing this shape is why the first version of this
      //     guard passed while CI was red.
      let m;
      const relRe = /(?:import|require)\(\s*["'](\.\.?\/[^"']+)["']/g;
      while ((m = relRe.exec(src)) !== null) {
        const resolved = path.normalize(path.join(path.dirname(t), m[1]));
        if (fs.existsSync(path.join(ROOT, resolved))) reachable.add(resolved);
      }
      const rootRe = /["']((?:scripts|js)\/[\w.-]+\.(?:mjs|js))["']/g;
      while ((m = rootRe.exec(src)) !== null) {
        if (fs.existsSync(path.join(ROOT, m[1]))) reachable.add(m[1]);
      }
    }

    const offenders = [];
    for (const file of reachable) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      let m;
      bareImport.lastIndex = 0;
      while ((m = bareImport.exec(src)) !== null) {
        if (isNpm(m[1])) offenders.push(`${file} imports "${m[1]}" at the top level`);
      }
    }
    ok(offenders.length === 0,
      "a unit test reaches code that imports an npm package at the top level; " +
      "CI runs `node test/run.js` with no node_modules, so this fails there " +
      "and passes here: " + JSON.stringify(offenders, null, 1));
  });

  suite("static: no personnel workbook reaches this public repository");

  await test("no spreadsheet is tracked in the repo", () => {
    // This repo is PUBLIC, and scripts/ship.sh runs `git add -A`. The blanket
    // *.csv rule in .gitignore exists because a real nominal roll must never
    // land here; a spreadsheet carries the same personnel data and hides it
    // better. A workbook is a zip, so a reviewer skimming the diff sees one
    // binary blob, not the names, platoons, ranks and leave balances inside.
    //
    // The duty schedule workbooks are the live example: they sat untracked but
    // un-ignored in the working tree, one `ship.sh` away from public history.
    // gitignore alone is not the guard, because a `git add -f` or a rule
    // regression silently re-opens it, and git history is forever (PR #42
    // scrubbed leaked names from the files and they are still in the log).
    //
    // Tools read workbooks from a path argument. None is ever copied in.
    const tracked = require("child_process")
      .execSync("git ls-files -z", { cwd: ROOT, maxBuffer: 1 << 24 })
      .toString("utf8").split("\0").filter(Boolean);
    const offenders = tracked.filter((f) => /\.(xlsx|xlsm|xlsb|xls|ods|numbers)$/i.test(f));
    ok(offenders.length === 0,
      "a spreadsheet is tracked in a public repo and almost certainly carries " +
      "real personnel data; remove it from the index and keep it out of the " +
      "tree: " + JSON.stringify(offenders, null, 1));
  });

  await test(".gitignore keeps personnel data out by extension, not by filename", () => {
    // A rule naming one workbook (`cougar_fitness_tracker.xlsx`) protected
    // exactly that filename and nothing else. The next workbook someone drops
    // in the root is unprotected, which is how this was found. Blanket rules
    // only; the two deliberate exceptions stay pinned so a future edit that
    // drops them is visible here rather than at review time.
    const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    const rules = gi.split("\n").map((l) => l.trim());
    for (const need of ["*.csv", "*.xlsx", "*.xls"]) {
      ok(rules.includes(need), `.gitignore must carry the blanket rule ${need}`);
    }
    for (const keep of ["!sample_polar.csv", "!docs/nominal-roll-template.csv"]) {
      ok(rules.includes(keep), `.gitignore lost its deliberate exception ${keep}`);
    }
  });
};
