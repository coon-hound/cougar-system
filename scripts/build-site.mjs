#!/usr/bin/env node
// ============================================================================
// build-site.mjs — turn a copy of the repo into what GitHub Pages serves.
//
//   node scripts/build-site.mjs <site-dir> <version>
//
// Run by .github/workflows/pages.yml on every push to master, against a copy
// of the checkout (never the checkout itself). Two jobs:
//
//   1. Stamp the cache-buster. The repo's index.html carries `?v=dev` on every
//      script and stylesheet and NEVER a number, so two open PRs can no longer
//      both bump it to the same N and conflict. The deploy writes the real
//      version (the workflow's run number) here, so every deploy changes the
//      URL of every file and phones fetch fresh copies.
//
//   2. Gather the patch notes. Each note is its own file, notes/<id>.json,
//      so two PRs that each add one touch different files and merge cleanly.
//      They are collected into notes/index.json, newest first, which
//      js/patchnotes.js fetches on launch.
//
// Zero npm dependencies (CI runs it straight after checkout).
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEV_VERSION = "dev";

// A note id is its filename: a date for order, then a slug.
export const NOTE_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;

/**
 * Replace every `?v=dev` in index.html. Refuses a page with none (stamping
 * nothing would ship a page every phone keeps serving from cache) and a page
 * with a hand-typed number left in it (half-stamped is the same bug).
 */
export function stampVersion(html, version) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(version)) || version === DEV_VERSION) {
    throw new Error(`not a deployable version: ${JSON.stringify(version)}`);
  }
  const stray = html.match(/\?v=(?!dev\b)[^"'&\s>]+/);
  if (stray) throw new Error(`index.html has a hand-set ${stray[0]}; every cache-buster must be ?v=${DEV_VERSION}`);
  const n = (html.match(/\?v=dev\b/g) || []).length;
  if (!n) throw new Error(`index.html has no ?v=${DEV_VERSION} to stamp`);
  return { html: html.replace(/\?v=dev\b/g, `?v=${version}`), count: n };
}

/** One note file, checked. Throws with the file named, so CI says which. */
export function parseNote(file, text) {
  const id = path.basename(file, ".json");
  if (!NOTE_ID.test(id)) throw new Error(`${file}: name it YYYY-MM-DD-some-slug.json`);
  let n;
  try { n = JSON.parse(text); } catch (e) { throw new Error(`${file}: not valid JSON (${e.message})`); }
  const str = (v) => typeof v === "string" && v.trim() !== "";
  if (!str(n.title)) throw new Error(`${file}: needs a "title"`);
  if (!str(n.date)) throw new Error(`${file}: needs a "date" as shown to users, e.g. "2 Nov 2026"`);
  if (!Array.isArray(n.items) || !n.items.length) throw new Error(`${file}: needs a non-empty "items" list`);
  n.items.forEach((it, i) => {
    if (!(str(it) || (it && str(it.t) && (it.d === undefined || typeof it.d === "string")))) {
      throw new Error(`${file}: item ${i + 1} must be a string or {"t": "...", "d": "..."}`);
    }
  });
  return { id, date: n.date, title: n.title, ...(str(n.intro) ? { intro: n.intro } : {}), items: n.items };
}

/** Every notes/*.json in a directory, newest first (by id). */
export function collectNotes(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .sort()
    .reverse()
    .map((f) => parseNote(f, fs.readFileSync(path.join(dir, f), "utf8")));
}

function main(argv) {
  const [site, version] = argv;
  if (!site || !version) {
    console.error("usage: node scripts/build-site.mjs <site-dir> <version>");
    process.exit(2);
  }
  const indexPath = path.join(site, "index.html");
  const { html, count } = stampVersion(fs.readFileSync(indexPath, "utf8"), version);
  fs.writeFileSync(indexPath, html);
  const notes = collectNotes(path.join(site, "notes"));
  fs.mkdirSync(path.join(site, "notes"), { recursive: true });
  fs.writeFileSync(path.join(site, "notes", "index.json"), JSON.stringify(notes));
  console.log(`stamped ${count} cache-busters as ?v=${version}; ${notes.length} patch note(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
