#!/usr/bin/env node
// ============================================================================
// ippt-import.mjs - IPPT results from the IPPT app's screenshots into the
// `ippt` table, at 100% accuracy or not at all. Procedure: docs/IPPT-IMPORT.md.
//
//   Preview (reads only, writes nothing but files in <dir>):
//     DATABASE_URL=... node scripts/ippt-import.mjs <dir> --attempt 1 --date "23 Sep 2026"
//
//   Apply (one transaction; all of it or none of it):
//     DATABASE_URL=... node scripts/ippt-import.mjs <dir> --attempt 1 --date "23 Sep 2026" --apply
//
// <dir> holds the screenshots (*.jpeg / *.jpg / *.png) and visual.json, a
// BLIND visual transcription of the same screenshots (see the doc for its
// shape and for how to produce it). This script adds the second, mechanical
// read (Apple Vision OCR via scripts/ippt-ocr.swift), re-reads any cell the OCR
// missed from a cropped and enlarged image, and then refuses to go on unless:
//   1. every field is read identically by BOTH sources in every screenshot
//      it appears in,
//   2. (a cross-check, not a gate on the score) every result's stations are
//      compared with the app's printed total under the official scoring tables
//      (js/ippt-scoring.js). The PRINTED score is the single truth and is what
//      gets written; a mismatch is reported so the station reads get a second
//      look, and

//   3. every enlistee maps to exactly one roster 4D by an exact name match
//      (or a human pin: --pin 3:14=7105, detail 3 row 14 is 4D 7105).
//
// Options: --series KH (default) | BMT, --pin D:IDX=4D (repeatable),
// --replace (overwrite a different existing result for the same IPPT),
// --names (print names; off by default, the report gets pasted around).
//
// macOS only (Vision). Screenshots saved out of WhatsApp carry a
// com.apple.macl tag that stops a terminal reading them until it has Full
// Disk Access: "Operation not permitted" on a file you can see means that.
// ============================================================================

// `postgres` is imported lazily inside main(): CI runs `node test/run.js` with
// no `npm install` (see scripts/promote.mjs).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  COLUMNS, gate, inferIndexes, matchNames, parseShot, planImport, reconcile, verificationCsv,
} from "./ippt-import-plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const out = { dir: null, apply: false, names: false, replace: false, series: "KH", attempt: null, date: null, pins: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--names") out.names = true;
    else if (a === "--replace") out.replace = true;
    else if (a === "--series") out.series = String(argv[++i] ?? "").toUpperCase();
    else if (a === "--attempt") out.attempt = String(argv[++i] ?? "");
    else if (a === "--date") out.date = String(argv[++i] ?? "");
    else if (a === "--pin") {
      const m = String(argv[++i] ?? "").match(/^(\d+):(\d+)=(\d{4})$/);
      if (!m) throw new Error("--pin wants DETAIL:ROW=4D, e.g. 3:14=7105");
      out.pins[`${m[1]}:${m[2]}`] = m[3];
    } else if (!a.startsWith("--") && !out.dir) out.dir = a;
  }
  return out;
}

// The app's own scoring, loaded the way index.html loads it (a classic script).
export function loadScoring() {
  const sandbox = { Math, String, Number };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js/ippt-scoring.js"), "utf8"), sandbox);
  const AGE = { 1: 18, 2: 23, 3: 26 };   // any age inside the group
  return (ag, pu, su, run) => sandbox.calculateIPPTScore(AGE[ag], pu, su, run || "0:00").total;
}

function ocrBinary() {
  const bin = path.join(os.tmpdir(), "cougar-ippt-ocr");
  const src = path.join(ROOT, "scripts/ippt-ocr.swift");
  if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs) {
    execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
  }
  return bin;
}

function ocr(bin, files) {
  return execFileSync(bin, files, { encoding: "utf8", maxBuffer: 64 << 20 })
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Re-read one cell the full-screen OCR missed: crop it, enlarge it and OCR it
// again at several crop sizes. Accept a value only when at least two crops
// read it and no crop read anything else. Vision drops a lone narrow glyph
// ("41", "51") on a full screen far more often than it misreads one.
function reocrCell(bin, file, y, field, workDir) {
  const { w: W, h: H } = imageSize(file);
  const [x0, x1] = COLUMNS[field];
  const reads = [];
  for (const [pad, inset, scale] of [[[0.012, 0.03], 0, 3], [[0.006, 0.026], 0.03, 5], [[0.004, 0.022], 0.05, 6], [[0.008, 0.028], 0.02, 4]]) {
    const top = Math.max(0, Math.floor((y - pad[0]) * H)), height = Math.floor((pad[0] + pad[1]) * H);
    const left = Math.floor((x0 + inset) * W), width = Math.floor((x1 - x0 - inset) * W);
    const out = path.join(workDir, `crop-${reads.length}-${path.basename(file)}-${field}.png`);
    execFileSync("sips", ["-s", "format", "png", "--cropToHeightWidth", String(height), String(width),
      "--cropOffset", String(top), String(left), file, "--out", out], { stdio: "ignore" });
    execFileSync("sips", ["-z", String(height * scale), String(width * scale), out], { stdio: "ignore" });
    const [res] = ocr(bin, [out]);
    const texts = res.items.map((i) => i.text.trim()).filter(Boolean);
    reads.push(texts.length === 1 ? texts[0] : null);
  }
  const got = reads.filter((v) => v != null);
  return got.length >= 2 && new Set(got).size === 1 ? got[0] : null;
}

function imageSize(file) {
  const outp = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  return { w: +outp.match(/pixelWidth:\s*(\d+)/)[1], h: +outp.match(/pixelHeight:\s*(\d+)/)[1] };
}

const who = (r, names) => `D${r.detail} #${String(r.idx).padStart(2)}${names ? ` ${r.rank || ""} ${r.name || ""}` : ""}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.attempt || !args.date || !["KH", "BMT"].includes(args.series)) {
    console.error('usage: DATABASE_URL=... node scripts/ippt-import.mjs <dir> --attempt N --date "DD Mon YYYY" [--series KH|BMT] [--pin D:IDX=4D] [--replace] [--names] [--apply]');
    process.exitCode = 2; return;
  }
  if (!/^\d{2} [A-Z][a-z]{2} \d{4}$/.test(args.date)) throw new Error(`--date must look like "23 Sep 2026", got "${args.date}"`);
  const dir = path.resolve(args.dir);
  const images = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f) && !f.startsWith("crop-")).sort()
    .map((f) => path.join(dir, f));
  const visPath = path.join(dir, "visual.json");
  if (!images.length) throw new Error(`no screenshots in ${dir}`);
  if (!fs.existsSync(visPath)) throw new Error(`${visPath} is missing - the blind visual read comes first (docs/IPPT-IMPORT.md)`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ippt-import-"));

  // ── Read 1: OCR ──
  const bin = ocrBinary();
  const shots = ocr(bin, images);
  const byName = new Map(images.map((f) => [path.basename(f), f]));
  const ocrRows = inferIndexes(shots.flatMap((s) => parseShot(s)));

  // ── Read 2: the blind visual transcription, keyed by the same file names ──
  const vis = JSON.parse(fs.readFileSync(visPath, "utf8"));
  const visRows = inferIndexes(vis.map((r) => ({ ...r })));

  // ── Targeted re-OCR of cells the full-screen pass missed ──
  let { rows, problems } = reconcile(ocrRows, visRows);
  const patched = [];
  for (const p of problems.filter((p) => ["pu", "su", "run"].includes(p.field) && p.why === "only one source read it")) {
    const [d, i] = p.key.split(":").map(Number);
    const app = ocrRows.find((r) => r.detail === d && r.idx === i && !r.cutTop && !r.cutBottom && r.y != null);
    if (!app) continue;
    const v = reocrCell(bin, byName.get(app.shot), app.y, p.field, work);
    if (v != null) { ocrRows.push({ ...app, pu: null, su: null, run: null, tag: null, pts: null, [p.field]: v, src: "ocr-crop", name: null }); patched.push(`${p.key} ${p.field}=${v}`); }
  }
  if (patched.length) ({ rows, problems } = reconcile(ocrRows, visRows));

  console.log(`Screenshots: ${images.length}   OCR rows: ${ocrRows.length}   visual rows: ${visRows.length}   sheet rows: ${rows.length}`);
  if (patched.length) console.log(`Re-read from enlarged crops: ${patched.join(", ")}`);
  const details = [...new Set(rows.map((r) => r.detail))].sort((a, b) => a - b);
  for (const d of details) {
    const idxs = rows.filter((r) => r.detail === d).map((r) => r.idx).sort((a, b) => a - b);
    const gaps = []; for (let k = 1; k <= idxs[idxs.length - 1]; k++) if (!idxs.includes(k)) gaps.push(k);
    console.log(`  Detail ${d}: rows 1-${idxs[idxs.length - 1]}${gaps.length ? `   MISSING ${gaps.join(",")}` : ""}`);
    if (gaps.length) problems.push({ key: `${d}:*`, field: "coverage", why: `rows ${gaps.join(",")} are in no screenshot` });
  }

  // ── Gate: the official tables must reproduce every printed total ──
  const failures = gate(rows, loadScoring());
  const ag = rows.filter((r) => r.ageGroup).reduce((m, r) => ({ ...m, [r.ageGroup]: (m[r.ageGroup] || 0) + 1 }), {});
  console.log(`Score cross-check: ${rows.filter((r) => r.status === "result").length - failures.length}/${rows.filter((r) => r.status === "result").length} results reproduce their printed total (age groups that fit: ${Object.entries(ag).map(([k, v]) => `AG${k} ${v}`).join(", ")})`);

  const stop = [];
  for (const p of problems) stop.push(`READ   ${p.key} ${p.field}: ${p.why} ${JSON.stringify(p.values || "")}`);
  // The printed score is the single truth (owner's rule): it is what gets
  // written, always, and the tables never override it. A score the stations do
  // not re-derive is shown so the station READS get a second look against the
  // screenshot - it does not stop the import.
  for (const f of failures) console.log(`  CHECK  D${f.key.replace(":", " #")}: stations ${f.row.pu}/${f.row.su}/${f.row.run} give ${f.computed.map((c, i) => `AG${i + 1} ${c}`).join(" / ")}, the app printed ${f.row.pts}. ${f.row.pts} is what is written; re-check the station reads against the screenshot.`);

  // ── Match to the roster, plan, report ──
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL, { prepare: false });
  try {
    const roster = await sql`select "id", "name", "role" from roster where deleted_at is null and position('@' in "id") = 0`;
    const existing = (await sql`select "id", "d4", "attempt", "date", "pushups", "situps", "runTime", "score", extra from ippt
       where deleted_at is null and position('@' in coalesce(d4, '')) = 0`).map((e) => ({ ...e, series: e.extra?.series }));
    const departed = await sql`select "id", "name" from roster where position('-out-' in "id") > 0`;
    matchNames(rows, roster, args.pins, departed);
    const plan = planImport({ rows, existing, series: args.series, attempt: args.attempt, date: args.date });

    fs.writeFileSync(path.join(dir, "reconciled.json"), JSON.stringify(rows, null, 1));
    const stamp = args.date.replace(/^(\d{2}) (\w{3}) \d{2}(\d{2})$/, (_, d, m, y) => `${d}${String("JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m) / 3 + 1).padStart(2, "0")}${y}`);
    fs.writeFileSync(path.join(dir, `ippt_${stamp}_verification.csv`), verificationCsv(rows));

    console.log(`\nIPPT ${args.series} ${args.attempt}, ${args.date}`);
    console.log(`  import ${plan.insert.length}   already identical ${plan.same.length}   conflicts ${plan.conflicts.length}   excluded ${plan.excluded.length}   unmatched ${plan.unmatched.length}`);
    for (const x of plan.excluded) console.log(`  excluded   ${args.names ? x.who : x.who.replace(/ \S+ .*$/, "")}: ${x.why}`);
    for (const x of plan.unmatched) {
      stop.push(`MATCH  ${x.who}: ${x.why}`);
      console.log(`  UNMATCHED  ${x.who}: ${x.why}${x.candidates.length ? `\n             nearest: ${x.candidates.map((c) => `${c.d4}${args.names ? ` ${c.name}` : ""}${c.score != null ? ` (${c.score.toFixed(2)})` : ""}`).join(", ")}` : ""}`);
    }
    for (const c of plan.conflicts) {
      console.log(`  CONFLICT   ${c.row.d4}: stored ${c.prev.pushups}/${c.prev.situps}/${c.prev.runTime}=${c.prev.score}, sheet ${c.row.pushups}/${c.row.situps}/${c.row.runTime}=${c.row.score}`);
      if (!args.replace) stop.push(`STORED ${c.row.d4}: a different result is already stored for this IPPT (--replace to overwrite)`);
    }
    for (const r of rows.filter((r) => r.match?.how === "pinned")) console.log(`  pinned     ${who(r, args.names)} -> ${r.match.d4}`);

    // Closed set: every enlistee on the roster is either on a detail list or
    // reported here as absent from all of them. Nobody vanishes silently.
    const onSheet = new Set(rows.map((r) => r.match?.d4).filter(Boolean));
    const absent = roster.filter((p) => String(p.role).toLowerCase() !== "commander" && !onSheet.has(String(p.id)));
    const notReg = rows.filter((r) => r.status === "not-registered");
    console.log(`
  Enlistees on the roster: ${roster.filter((p) => String(p.role).toLowerCase() !== "commander").length}. Results: ${plan.insert.length + plan.same.length + plan.conflicts.length}. On a list but not registered: ${notReg.length}. On no list: ${absent.length}.`);
    for (const r of notReg) console.log(`    not registered  ${r.match?.d4 || "?"}${args.names ? ` ${r.match?.name || r.name}` : ""}`);
    for (const p of absent) console.log(`    on no list      ${p.id}${args.names ? ` ${p.name}` : ""}`);

    if (stop.length) {
      console.log(`\nSTOPPED - ${stop.length} problem(s). Nothing was written.`);
      for (const s of stop) console.log("  " + s);
      process.exitCode = 1; return;
    }
    const writes = [...plan.insert, ...(args.replace ? plan.conflicts : [])];
    if (!writes.length) { console.log("\nNothing to write: every result is already stored."); return; }
    if (!args.apply) { console.log(`\nAll checks passed. Preview only - nothing was written. Add --apply to write ${writes.length} row(s).`); return; }

    const written = await sql.begin(async (tx) => {
      let n = 0;
      for (const { row } of writes) {
        const { series, ...cols } = row;
        await tx`
          insert into ippt ("id", "d4", "attempt", "date", "pushups", "situps", "runTime", "score", extra)
          values (${cols.id}, ${cols.d4}, ${cols.attempt}, ${cols.date}, ${cols.pushups}, ${cols.situps}, ${cols.runTime}, ${cols.score}, ${tx.json({ series })})
          on conflict ("id") do update set
            "d4" = excluded."d4", "attempt" = excluded."attempt", "date" = excluded."date",
            "pushups" = excluded."pushups", "situps" = excluded."situps", "runTime" = excluded."runTime",
            "score" = excluded."score", extra = ippt.extra || excluded.extra, deleted_at = null`;
        n++;
      }
      // Without the bump no phone learns the tab changed until a full reload.
      await tx`select bump_rev('IPPT')`;
      return n;
    });
    console.log(`\nAPPLIED. ${written} IPPT row(s) written, IPPT rev bumped.`);
  } finally {
    await sql.end({ timeout: 5 });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}
