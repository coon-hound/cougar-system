// ============================================================================
// ippt-import-plan.mjs - the pure half of scripts/ippt-import.mjs.
//
// Everything here is a function of its arguments: no database, no files, no
// OCR engine. That is what lets test/ippt-import.test.js pin the parser, the
// two-read reconciliation, the scoring gate and the name matcher on invented
// data. See docs/IPPT-IMPORT.md for the procedure these serve.
//
// The accuracy argument, in one paragraph: a value is imported only when two
// INDEPENDENT reads of the screenshot agree on it (Apple Vision OCR, and a
// blind visual transcription), every appearance of the row across overlapping
// screenshots agrees, and the three station counts reproduce the app's printed
// total under the official scoring tables. A misread has to fool two unrelated
// readers identically AND land on another combination that scores the same
// total to get through.
// ============================================================================

// ── 1. Parsing one screenshot's OCR boxes into rows ─────────────────────────
//
// The IPPT app ("DETAIL n" screen) lays each row out as, in normalised x:
//   idx. RANK NAME...  (x < 0.13) | push-ups ~0.59 | sit-ups ~0.70 | run ~0.81
//   name continuation lines at x ~0.18
//   Tag No: T  (x ~0.10)                              NN pts (x ~0.80)
// The numbers sit a few pixels ABOVE the name on the same visual line, so boxes
// are clustered into lines by y before anything else.

export const COLUMNS = { pu: [0.5, 0.65], su: [0.65, 0.76], run: [0.76, 0.95] };

function column(x) {
  for (const [k, [lo, hi]] of Object.entries(COLUMNS)) if (x >= lo && x < hi) return k;
  return "left";
}

function clusterLines(items, tol = 0.012) {
  const lines = [];
  for (const it of [...items].sort((a, b) => a.y - b.y)) {
    const last = lines[lines.length - 1];
    if (last && it.y - last.y <= tol) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

const clean = (v) => (v == null ? null : String(v).trim().replace(/\s*:$/, "").trim());

// shot = { file, items: [{text, x, y, w, h, conf}] } with y from the TOP.
// Returns rows { shot, detail, idx, rank, name, pu, su, run, tag, pts, y,
// cutTop, cutBottom }. A row cut by the screen edge keeps what is visible and
// says so; the reconciler decides what a cut row may vouch for.
export function parseShot(shot, { bodyTop = 0.2 } = {}) {
  const detailBox = shot.items.find((i) => /DETAIL\s*\d+/.test(i.text));
  if (!detailBox) throw new Error(`${shot.file}: no "DETAIL n" header found`);
  const detail = +detailBox.text.match(/DETAIL\s*(\d+)/)[1];
  // The app prints a legend at the foot of a list ('"-" indicates ... did not
  // complete the station. "E" indicates excused.'). Scrolled next to a row it
  // would read as that row's name, so it is dropped before anything else.
  const LEGEND = /indicates|did not complete|complete the station|excused\./i;
  const body = shot.items.filter((i) => i.y > bodyTop && !LEGEND.test(i.text));

  const blocks = [];
  let cur = null;
  for (const line of clusterLines(body)) {
    const texts = line.items.map((i) => ({ x: i.x, t: i.text.trim() }));
    if (texts.some((e) => e.t.startsWith("Tag No"))) {
      if (!cur) { cur = { lines: [], cutTop: true }; blocks.push(cur); }
      for (const { t } of texts) {
        const pts = t.match(/^(\d+)\s*pts$/);
        if (t.startsWith("Tag No")) cur.tag = t.replace(/^Tag No:?\s*/, "");
        else if (pts) cur.pts = pts[1];
      }
      cur.closed = true;
      continue;
    }
    if (!cur || cur.closed) {
      // The first block starts cut only when its first line has no left
      // column (index/rank/name): then its head scrolled off the top.
      const first = !cur;
      cur = { lines: [], y: line.y, cutTop: first && !texts.some((e) => column(e.x) === "left") };
      blocks.push(cur);
    }
    cur.lines.push(texts);
  }

  return blocks.map((b) => {
    const name = [], nums = {};
    let idx = null;
    b.lines.forEach((texts, li) => {
      for (const { x, t } of texts) {
        const c = column(x);
        if (c === "left") {
          let s = t;
          const m = s.match(/^(\d+)\.\s*(.*)$/);
          if (m && li === 0) { idx = +m[1]; s = m[2]; }
          if (s) name.push(s);
        } else if (li === 0 && !(c in nums)) nums[c] = t;
      }
    });
    const full = name.join(" ").replace(/\s+/g, " ").trim();
    const rk = full.match(/^(PTE|REC|LCP|CPL|3SG|2SG|1SG|SSG|MSG|2LT|LTA|CPT)\s+(.*)$/);
    return {
      shot: shot.file, detail, idx,
      rank: rk ? rk[1] : null, name: rk ? rk[2] : (full || null),
      pu: clean(nums.pu), su: clean(nums.su), run: clean(nums.run),
      tag: b.tag ?? null, pts: b.pts ?? null, y: b.y ?? null,
      cutTop: !!b.cutTop, cutBottom: !b.closed,
    };
  });
}

// A row whose index scrolled away takes it from its neighbours in the same shot.
export function inferIndexes(rows) {
  const byShot = new Map();
  for (const r of rows) (byShot.get(r.shot) || byShot.set(r.shot, []).get(r.shot)).push(r);
  for (const list of byShot.values()) {
    list.forEach((r, i) => {
      if (r.idx != null) return;
      const n = list.findIndex((x, j) => j > i && x.idx != null);
      if (n >= 0) { r.idx = list[n].idx - (n - i); return; }
      const p = list.map((x, j) => [x, j]).filter(([x, j]) => j < i && x.idx != null).pop();
      if (p) r.idx = p[0].idx + (i - p[1]);
    });
  }
  return rows;
}

// ── 2. Reconciling the two reads ────────────────────────────────────────────

export const FIELDS = ["pu", "su", "run", "tag", "pts"];

// "-", "-:-", "--", "- :" and friends all mean "station not done".
export function normValue(field, v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (s === "") return null;
  if (/^[-–—•:\s]+$/.test(s)) return "-";
  if (field === "run") {
    s = s.replace(/\./g, ":");
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : s;
  }
  if (field === "pu" || field === "su" || field === "pts") return /^\d+$/.test(s) ? String(+s) : s;
  return s;
}

// Which fields a partial appearance may vouch for. The numbers sit on a row's
// FIRST line, so a row cut at the top has lost them (whatever survived is a
// clipped glyph), and a row cut at the bottom has lost its Tag/pts line and
// may have its numbers half-clipped too - the one read we saw go wrong
// ("11.21" for 11:21) was exactly that.
function vouches(app, field) {
  if (app.cutBottom) return false;
  if (app.cutTop) return field === "tag" || field === "pts";
  return true;
}

// ocr, vis: row lists (vis rows use `cut: "top"|"bottom"|null`). Returns
// { rows, problems }. A field is accepted only when every vouching appearance
// agrees AND both sources vouch for it. "Not Registered" rows carry no result,
// so only their status has to agree.
export function reconcile(ocr, vis) {
  const apps = new Map();
  const add = (r, src) => {
    const key = `${r.detail}:${r.idx}`;
    const a = { ...r, src, cutTop: r.cutTop ?? r.cut === "top", cutBottom: r.cutBottom ?? r.cut === "bottom" };
    (apps.get(key) || apps.set(key, []).get(key)).push(a);
  };
  ocr.forEach((r) => add(r, r.src || "ocr"));
  vis.forEach((r) => add(r, "vis"));

  const rows = [], problems = [];
  const keys = [...apps.keys()].sort((a, b) => {
    const [da, ia] = a.split(":").map(Number), [db, ib] = b.split(":").map(Number);
    return da - db || ia - ib;
  });
  for (const key of keys) {
    const list = apps.get(key);
    const [detail, idx] = key.split(":").map(Number);
    if (!Number.isFinite(idx)) { problems.push({ key, field: "idx", why: "row index could not be placed", values: list.map((a) => a.shot) }); continue; }
    const row = { detail, idx, reads: {} };
    const tagVals = list.filter((a) => vouches(a, "tag")).map((a) => normValue("tag", a.tag)).filter((v) => v != null);
    const notReg = tagVals.length > 0 && tagVals.every((v) => /not\s*registered/i.test(v));
    for (const f of FIELDS) {
      const vals = list.filter((a) => vouches(a, f)).map((a) => ({ src: a.src.startsWith("ocr") ? "ocr" : a.src, shot: a.shot, v: normValue(f, a[f]) })).filter((x) => x.v != null);
      row.reads[f] = vals.length;
      const distinct = [...new Set(vals.map((x) => x.v))];
      const srcs = new Set(vals.map((x) => x.src));
      if (notReg && f !== "tag") { row[f] = null; continue; }
      if (f === "pts" && !vals.length) { row[f] = null; continue; }   // a blank row prints no total
      if (distinct.length === 1 && srcs.has("ocr") && srcs.has("vis")) row[f] = distinct[0];
      // A dash is "station not done", and OCR routinely returns NOTHING for a
      // lone dash. One source reading "-" and the other reading no text at all
      // is agreement that there is no number here. It cannot hide a missed
      // number: a real result carries a printed total, and the scoring gate
      // re-derives that total from the stations.
      else if (distinct.length === 1 && distinct[0] === "-" && ["pu", "su", "run"].includes(f)) row[f] = "-";
      else {
        row[f] = null;
        problems.push({ key, field: f, why: distinct.length > 1 ? "reads disagree" : "only one source read it", values: vals });
      }
    }
    // The name comes from the visual read: OCR drops spaces inside names
    // ("LOHZHENG"), and a name only has to be good enough to match exactly.
    const vn = list.filter((a) => a.src === "vis" && a.name && !a.cutTop).map((a) => a.name);
    row.name = vn.sort((a, b) => b.length - a.length)[0] || list.find((a) => a.name)?.name || null;
    row.rank = list.find((a) => a.src === "vis" && a.rank)?.rank || list.find((a) => a.rank)?.rank || null;
    row.status = notReg ? "not-registered"
      : [row.pu, row.su, row.run].every((v) => v === "-") ? "dns"
      : "result";
    rows.push(row);
  }
  return { rows, problems };
}

// ── 3. The scoring cross-check ──────────────────────────────────────────────
//
// The score printed by the IPPT app is the single truth: it is what gets
// written, and nothing here ever replaces it with a computed one. What this
// checks is the STATION reads - a push-up count read wrong by both readers
// identically would still have to re-derive the printed total to go unnoticed.
//
// `score(ageGroup, pu, su, runTime)` is injected: the CLI and the tests pass the
// app's own calculateIPPTScore from js/ippt-scoring.js, so the app and this
// gate can never disagree about what a result is worth. Age group is not on the
// screen (the app knows each man's birthday, this script does not), so a row
// passes when any group a serviceman in this company can be in reproduces the
// printed total, and the groups that fit are recorded for the report. KH 1 had
// AG1 (<22), AG2 (22-24) and one man in AG3 (25-27).
export const AGE_GROUPS = [1, 2, 3];
export function gate(rows, score) {
  const failures = [];
  for (const r of rows) {
    if (r.status !== "result") continue;
    const pu = r.pu === "-" ? 0 : +r.pu, su = r.su === "-" ? 0 : +r.su;
    const run = r.run === "-" ? null : r.run;
    const fits = AGE_GROUPS.filter((ag) => score(ag, pu, su, run) === +r.pts);
    r.ageGroup = fits.length ? fits.join("/") : null;
    if (!fits.length) failures.push({ key: `${r.detail}:${r.idx}`, row: r, computed: AGE_GROUPS.map((ag) => score(ag, pu, su, run)) });
  }
  return failures;
}

// ── 4. Name -> 4D ───────────────────────────────────────────────────────────
//
// Exact unordered token sets only (CLAUDE.md, "Names in this dataset"): the
// token pool is small enough that two shared tokens mean nothing, and what is
// being guessed at is whose record this is. Anything short of exact is listed
// with ranked candidates for a human, who pins it with --pin.
const FILLER = new Set(["BIN", "BINTE", "BINTI", "BTE", "SO", "DO", "S", "O", "D", "AL", "AP"]);
export function nameTokens(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/)
    .filter((t) => t && !FILLER.has(t)).sort();
}
const tokenKey = (name) => nameTokens(name).join(" ");

function bigrams(s) {
  const t = s.replace(/\s+/g, ""), out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}
export function dice(a, b) {
  const x = bigrams(tokenKey(a)), y = bigrams(tokenKey(b));
  if (!x.length || !y.length) return 0;
  const pool = [...y];
  let hit = 0;
  for (const g of x) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (x.length + y.length);
}

// roster: [{id, name, role}] (live seats); departed: archived rows of men who
// left mid-intake ({id: "9404@16-out-20260921", name}); pins: {"detail:idx": "4D"}.
// A departed man can still be on the app's detail list; he matches his
// archive key and is excluded, rather than stopping the run as unknown.
export function matchNames(rows, roster, pins = {}, departed = []) {
  const gone = new Map(departed.map((p) => [tokenKey(p.name), p]));
  const byKey = new Map();
  for (const p of roster) {
    const k = tokenKey(p.name);
    (byKey.get(k) || byKey.set(k, []).get(k)).push(p);
  }
  const used = new Map();
  for (const r of rows) {
    const key = `${r.detail}:${r.idx}`;
    if (pins[key]) {
      const p = roster.find((x) => String(x.id) === String(pins[key]));
      r.match = p ? { d4: String(p.id), name: p.name, role: p.role, how: "pinned" } : { error: `pinned 4D ${pins[key]} is not on the roster` };
    } else {
      const hits = byKey.get(tokenKey(r.name)) || [];
      if (hits.length === 1) r.match = { d4: String(hits[0].id), name: hits[0].name, role: hits[0].role, how: "exact" };
      else if (!hits.length && gone.has(tokenKey(r.name))) r.match = { departed: String(gone.get(tokenKey(r.name)).id), name: gone.get(tokenKey(r.name)).name, how: "departed" };
      else if (hits.length > 1) r.match = { error: `name matches ${hits.length} roster rows`, candidates: hits.map((h) => ({ d4: String(h.id), name: h.name })) };
      else r.match = {
        error: "no exact name match",
        candidates: roster.map((p) => ({ d4: String(p.id), name: p.name, score: dice(r.name, p.name) }))
          .sort((a, b) => b.score - a.score).slice(0, 3),
      };
    }
    if (r.match.d4) {
      if (used.has(r.match.d4)) r.match = { error: `4D ${r.match.d4} already taken by row ${used.get(r.match.d4)}` };
      else used.set(r.match.d4, key);
    }
  }
  return rows;
}

// ── 5. The import plan ──────────────────────────────────────────────────────

const ENLISTED = new Set(["PTE", "REC", "LCP", "CPL"]);

// existing: live IPPT rows ({id, d4, attempt, series, ...}) for the idempotency
// check. Returns { insert, skip, conflicts, excluded, unmatched }.
export function planImport({ rows, existing = [], series, attempt, date }) {
  const plan = { insert: [], same: [], conflicts: [], excluded: [], unmatched: [] };
  const have = new Map(existing
    .filter((e) => String(e.series) === series && String(+e.attempt) === String(+attempt))
    .map((e) => [String(e.d4), e]));
  for (const r of rows) {
    const who = `D${r.detail} #${r.idx} ${r.rank || "?"} ${r.name || "?"}`;
    if (r.status === "not-registered") { plan.excluded.push({ who, why: "not registered (did not take the test)", row: r }); continue; }
    if (r.rank && !ENLISTED.has(r.rank)) { plan.excluded.push({ who, why: `${r.rank}: commanders are not tracked in the IPPT tab`, row: r }); continue; }
    if (r.match?.departed) { plan.excluded.push({ who, why: `left the company (archived as ${r.match.departed})`, row: r }); continue; }
    if (!r.match?.d4) { plan.unmatched.push({ who, why: r.match?.error || "unmatched", candidates: r.match?.candidates || [], row: r }); continue; }
    if (String(r.match.role).toLowerCase() === "commander") { plan.excluded.push({ who, why: "roster role is Commander", row: r }); continue; }
    const dns = r.status === "dns";
    const out = {
      id: `ippt-${series.toLowerCase()}${+attempt}-${r.match.d4}`,
      d4: r.match.d4, attempt: String(+attempt), date,
      pushups: dns || r.pu === "-" ? "0" : r.pu,
      situps: dns || r.su === "-" ? "0" : r.su,
      runTime: dns || r.run === "-" ? "0:00" : r.run,
      score: dns ? "0" : r.pts,
      series,
    };
    const prev = have.get(out.d4);
    if (!prev) plan.insert.push({ row: out, src: r });
    else if (["pushups", "situps", "runTime", "score", "date"].every((k) => String(prev[k]) === String(out[k]))) plan.same.push({ row: out, src: r });
    else plan.conflicts.push({ row: out, prev, src: r });
  }
  return plan;
}

// The audit trail, one line per sheet row. It is what makes a recount
// possible later: the tag is how the conducting staff will name the man.
export function verificationCsv(rows) {
  const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ["detail", "idx", "tag", "rank", "sheet_name", "d4", "roster_name", "match", "status", "pushups", "situps", "run", "pts", "age_group"];
  const lines = rows.map((r) => [r.detail, r.idx, r.tag, r.rank, r.name, r.match?.d4, r.match?.name, r.match?.how || r.match?.error,
    r.status, r.pu, r.su, r.run, r.pts, r.ageGroup].map(q).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
