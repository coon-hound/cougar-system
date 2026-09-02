// ─── PARADE STATE COMPARE ENGINE ────────────────────────
// Pure parsing + diff functions for the "Compare Parade States" feature.
// No DOM access and no STATE writes — STATE.roster is read (guarded) only to
// bridge name-keyed people to their 4D. Loaded after helpers.js, before
// render.js/forms.js, and into the node vm harness for unit tests.
//
// Why parse text instead of regenerating from records: past parade states are
// NOT reconstructable (manual book-outs/force-ins are day-scoped mutable
// roster fields, borderline overrides are session-only), and the PDS hand-
// edits the textarea before sending. The stored snapshot text is the ground
// truth of what battalion actually received, so both sides of a diff are
// parsed from text — never from live records.

// Rank tokens stripped from names so a promotion (3SG → 2SG) never makes the
// same person diff as removed+added. Commanders print with NO 4D (paradeRN),
// so their identity is the rank-stripped name.
const PC_RANKS = "REC|PTE|LCP|CPL|CFC|SCT|3SG|2SG|1SG|SSG|MSG|3WO|2WO|1WO|MWO|SWO|OCT|2LT|LTA|CPT|MAJ|LTC|COL|ME[1-8]|SGT|CDT";
const PC_RANK_RE = new RegExp("^(?:" + PC_RANKS + ")\\b[ .]*", "i");

const PC_SECTION_LABELS = {
  ATTC: "ATTC",
  REPORT_SICK: "REPORT SICK",
  MEDICAL_STATUS: "MEDICAL STATUS",
  MEDICAL_APPT: "MEDICAL APPT",
  OTHERS: "OTHERS",
  UNKNOWN: "OTHER SECTION"
};
// Sections whose members are physically OUT of camp (drive CURRENT STRENGTH).
const PC_OUT_SECTIONS = { ATTC: true, OTHERS: true };
// The mostly-exclusive medical trio: a person shifting between these is one
// real-world event (e.g. Pending → MC issued, MC force-inned to MEDICAL
// STATUS) and must render as ONE "moved" change, never an out+in pair.
const PC_TRIO = ["ATTC", "REPORT_SICK", "MEDICAL_STATUS"];

// "180526" → "2026-05-18". DDMMYY only — battalion convention everywhere;
// never guess MMDDYY. Returns "" when the token isn't a valid calendar-ish day.
function ddmmyyToISO(tok) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(String(tok || "").trim());
  if (!m) return "";
  const dd = +m[1], mm = +m[2];
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return "";
  return `20${m[3]}-${m[2]}-${m[1]}`;
}

// Uppercase, de-accent-ish (NFKC), strip rank tokens + punctuation, collapse
// whitespace. "3SG  Nicholas Eng." → "NICHOLAS ENG".
function normalizeParadeName(s) {
  let out = String(s || "");
  try { out = out.normalize("NFKC"); } catch { /* older engines */ }
  out = out.toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  // Strip ONE leading rank token; "REC" doubles as a rank here.
  out = out.replace(PC_RANK_RE, "").trim();
  // Strip a trailing 4D that survived (e.g. "TAN AH KOW C1234" / "... 1234").
  out = out.replace(/\s+C?\d{4}$/i, "").trim();
  return out;
}

// Canonical person key: "d4:1404" when a standalone (C-prefixed or bare)
// 4-digit token exists, else "nm:<normalized name>". Identity comes from the
// TEXT only — a roster lookup must never be required (people leave the roster
// between snapshots); the roster only BRIDGES nm: keys to d4: keys later.
function pcFind4d(s) {
  // No lookbehind (old mobile Safari): capture the neighbour chars instead.
  const m = /(^|[^0-9A-Za-z])C?([0-9]{4})([^0-9]|$)/.exec(String(s || ""));
  return m ? m[2] : "";
}

function normalizeParadeKey(rnRaw) {
  const d4 = pcFind4d(rnRaw);
  if (d4) return "d4:" + d4;
  const nm = normalizeParadeName(rnRaw);
  return nm ? "nm:" + nm : "";
}

// "5D MC (consume in camp)" → { raw, family:"MC", days:5, inCamp:true }.
// family is the label minus the day-count prefix and the parenthesised notes,
// so "Excuse Running" and "Excuse Jumping" stay distinct families. "(extended)"
// marks a status carried on by a back-to-back re-issue (see statusRun) — still
// the same family, so it is stripped out and kept as its own flag; otherwise an
// extended MC would diff against a plain MC as removed + added.
function pcParseStatusLabel(raw) {
  const s = String(raw || "").trim();
  const inCamp = /consume in camp|kept in camp/i.test(s);
  const extended = /\(extended\)/i.test(s);
  let core = s.replace(/\((?:consume in camp|kept in camp|extended)\)/gi, "").trim();
  let days = null;
  const dm = /^(\d+)\s*D\b\s*/i.exec(core);
  if (dm) { days = +dm[1]; core = core.slice(dm[0].length); }
  const family = core.replace(/\s+/g, " ").trim().toUpperCase();
  return { raw: s, family: family || null, days, inCamp, extended, startIso: "", endIso: "" };
}

// Duration strings → {startIso, endIso}. Handles "180526 - 010626", a single
// "180526", ISO pairs, and dd/mm/yy(yy) pairs; anything else stays raw-only.
function pcParseDuration(raw) {
  const s = String(raw || "");
  let m = /(\d{6})\s*[-–—]\s*(\d{6})/.exec(s);
  if (m) return { startIso: ddmmyyToISO(m[1]), endIso: ddmmyyToISO(m[2]) };
  m = /(\d{4}-\d{2}-\d{2})\s*[-–—]\s*(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return { startIso: m[1], endIso: m[2] };
  m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*[-–—]\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) {
    const iso = (d, mo, y) => {
      const yy = y.length === 2 ? "20" + y : y;
      if (+d < 1 || +d > 31 || +mo < 1 || +mo > 12) return "";
      return `${yy}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    };
    return { startIso: iso(m[1], m[2], m[3]), endIso: iso(m[4], m[5], m[6]) };
  }
  m = /(\d{6})/.exec(s);
  if (m) return { startIso: ddmmyyToISO(m[1]), endIso: "" };
  return { startIso: "", endIso: "" };
}

// Fuzzy canonical-section mapping on a squeezed ALL-CAPS header label.
function pcSectionOf(label) {
  const l = String(label || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (/^ATT?C\b|ATTACHED OUT/.test(l)) return "ATTC";
  if (/^(REPORT(ED)? SICK|RSO|RSI)$/.test(l)) return "REPORT_SICK";
  if (/^MED(ICAL)? STATUS(ES)?( LIST)?$/.test(l)) return "MEDICAL_STATUS";
  if (/^(MED(ICAL)? APPTS?|MEDICAL APPOINTMENTS?|APPOINTMENTS?|MA)$/.test(l)) return "MEDICAL_APPT";
  if (/^(OTHERS?|LEAVE|OFF|DUTY)$/.test(l)) return "OTHERS";
  return "UNKNOWN";
}

// ─── parseParadeState(text) ─────────────────────────────
// Best-effort structural parse. Our own generator output parses losslessly
// (pinned by a round-trip unit test); foreign/hand-edited text degrades
// gracefully — unrecognized lines land in `unparsed`, and `confidence`
// tells the UI how hard to lean on the raw text diff instead.
function parseParadeState(text) {
  const out = {
    header: { type: null, dateIso: "", time: "", companyLine: null },
    strength: { total: null, current: null, platoons: {}, commanders: null },
    people: [],
    sectionCounts: {},
    sectionsSeen: {},          // canonical section → true (headers seen, even if empty)
    unparsed: [],
    warnings: [],
    personishLines: 0,
    confidence: "foreign"
  };
  const rawLines = String(text || "").split(/\r?\n/);

  let section = null;              // canonical section key, null = pre-section header region
  let sectionLabelRaw = "";
  let entry = null;                // entry under construction
  let multiStatus = false;         // inside a "Status received:" numbered block
  let canonicalSections = 0;

  const finishEntry = () => {
    if (!entry) return;
    // Empty-section skeletons ("S/N:" / "R/N:" with no value) are never a
    // person — require a name or a 4D.
    if (entry.d4 || entry.name) {
      entry.key = entry.d4 ? "d4:" + entry.d4 : (entry.name ? "nm:" + entry.name : "");
      // A "Status:"/"Status received:" never seen → statuses stays [].
      out.people.push(entry);
      const sec = entry.section;
      out.sectionCounts[sec] = out.sectionCounts[sec] || { claimed: null, actual: 0 };
      out.sectionCounts[sec].actual++;
    }
    entry = null;
    multiStatus = false;
  };

  const startEntry = (rnValue, line) => {
    finishEntry();
    const d4 = pcFind4d(rnValue);
    entry = {
      key: "", d4: d4 || null,
      name: normalizeParadeName(d4 ? String(rnValue).replace(new RegExp("C?" + d4), " ") : rnValue),
      rnRaw: String(rnValue || "").trim(),
      section: section || "UNKNOWN", sectionLabelRaw,
      sn: null, reason: "", location: "",
      apptDateIso: "", apptTime: "",
      statuses: [], rawBlock: line ? [line] : []
    };
  };

  for (const raw of rawLines) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (!t) continue;
    if (/^[-–—=_*]{5,}$/.test(t)) continue;                    // separator rows

    // Strength lines can appear anywhere (ours: pre-section; foreign: bottom).
    let m;
    if ((m = /^TOTAL(?:\s+STR(?:ENGTH)?)?\s*[:\-]\s*(\d+)(?:\s*\/\s*(\d+))?$/i.exec(t))) {
      out.strength.total = +m[1];
      continue;
    }
    if ((m = /^(?:CURRENT|PRESENT)(?:\s+STR(?:ENGTH)?)?\s*[:\-]\s*(\d+)(?:\s*\/\s*(\d+))?$/i.exec(t))) {
      out.strength.current = +m[1];
      if (m[2] && out.strength.total == null) out.strength.total = +m[2];
      continue;
    }
    if ((m = /^(?:PLATOON|PLT)\s*([A-Z0-9]+)\s*[:\-]\s*(\d+)\s*\/\s*(\d+)$/i.exec(t))) {
      out.strength.platoons[m[1]] = { in: +m[2], total: +m[3] };
      continue;
    }
    if ((m = /^(?:COMMANDERS?|CMDRS?)\s*[:\-]\s*(\d+)\s*\/\s*(\d+)$/i.exec(t))) {
      out.strength.commanders = { in: +m[1], total: +m[2] };
      continue;
    }

    // Section header: ALL-CAPS label + colon, optionally a claimed count
    // ("ATTC: 02" populated / "ATTC:" empty skeleton). Field lines like
    // "Reason: Fever" don't match — the tail must be digits or nothing.
    if ((m = /^([A-Z][A-Z /()&.'\-]{1,40}?)\s*:\s*(\d{1,3})?$/.exec(t))) {
      finishEntry();
      // "S/N:"/"R/N:" skeleton lines also fit this shape — they are entry
      // machinery, not sections; handled below, so exclude them here.
      if (!/^[SR]\/?N$/i.test(m[1])) {
        section = pcSectionOf(m[1]);
        sectionLabelRaw = m[1].trim();
        if (section !== "UNKNOWN" && !out.sectionsSeen[section]) canonicalSections++;
        out.sectionsSeen[section] = true;
        out.sectionCounts[section] = out.sectionCounts[section] || { claimed: null, actual: 0 };
        if (m[2]) out.sectionCounts[section].claimed = +m[2];
        continue;
      }
    }

    // Pre-section header region: company line, report type, date/time.
    if (section === null) {
      if (/\b(FIRST|LAST)\s+PARADE\s+STATE\b/i.test(t)) {
        out.header.type = /FIRST/i.test(t) ? "FP" : "LP";
        continue;
      }
      if ((m = /\bDATE\s*[:\-]?\s*(\d{6})(?:\s*@?\s*(\d{3,4}))?/i.exec(t)) ||
          (m = /\bas of\s+(\d{6})\s*[,@ ]*\s*(\d{3,4})?/i.exec(t))) {
        out.header.dateIso = ddmmyyToISO(m[1]) || out.header.dateIso;
        if (m[2]) out.header.time = m[2].padStart(4, "0");
        continue;
      }
      if ((m = /(\d{4}-\d{2}-\d{2})/.exec(t)) && !out.header.dateIso) {
        out.header.dateIso = m[1];
        continue;
      }
      if (out.header.companyLine === null) { out.header.companyLine = t; continue; }
      out.unparsed.push(t);
      continue;
    }

    // Inside a "Status received:" numbered block: "1. 5D MC" then "Duration:".
    if (multiStatus && (m = /^(\d+)[.)]\s*(.+)$/.exec(t))) {
      entry.statuses.push(pcParseStatusLabel(m[2]));
      entry.rawBlock.push(line);
      continue;
    }

    // S/N starts a fresh entry (ours). Value may be blank (empty skeleton).
    if ((m = /^S\/?N\s*[:\-]\s*(.*)$/i.exec(t))) {
      finishEntry();
      startEntry("", line);
      entry.name = "";                       // S/N carries no identity
      entry.rnRaw = "";
      entry.sn = m[1].trim() || null;
      continue;
    }

    // Field lines. Must be checked before the person heuristics — "Time:
    // 0930 Hrs" contains a standalone 4-digit token that is not a 4D.
    if ((m = /^R\/?N\s*[:\-]\s*(.*)$/i.exec(t))) {
      const v = m[1].trim();
      // Empty-skeleton "R/N:" lines (our own empty sections) are format
      // furniture, not person-looking lines — counting them would fail the
      // structured-view gate on any quiet-day parade state.
      if (v) out.personishLines++;
      if (entry && !entry.name && !entry.d4) {
        const d4 = pcFind4d(v);
        entry.d4 = d4 || null;
        entry.name = normalizeParadeName(d4 ? v.replace(new RegExp("C?" + d4), " ") : v);
        entry.rnRaw = v;
        entry.rawBlock.push(line);
      } else {
        startEntry(v, line);                 // foreign: R/N without S/N
      }
      continue;
    }
    if (entry && (m = /^Reason\s*[:\-]\s*(.*)$/i.exec(t))) { entry.reason = m[1].trim(); entry.rawBlock.push(line); continue; }
    if (entry && (m = /^Location\s*[:\-]\s*(.*)$/i.exec(t))) { entry.location = m[1].trim(); entry.rawBlock.push(line); continue; }
    if (entry && /^Status received\s*[:\-]?$/i.test(t)) { multiStatus = true; entry.rawBlock.push(line); continue; }
    if (entry && (m = /^Status\s*[:\-]\s*(.*)$/i.exec(t))) {
      if (m[1].trim()) entry.statuses.push(pcParseStatusLabel(m[1]));
      entry.rawBlock.push(line);
      continue;
    }
    if (entry && (m = /^Duration\s*[:\-]\s*(.*)$/i.exec(t))) {
      const d = pcParseDuration(m[1]);
      const target = entry.statuses[entry.statuses.length - 1];
      if (target) { target.startIso = d.startIso; target.endIso = d.endIso; target.durationRaw = m[1].trim(); }
      else entry.statuses.push({ raw: "", family: null, days: null, inCamp: false, startIso: d.startIso, endIso: d.endIso, durationRaw: m[1].trim() });
      entry.rawBlock.push(line);
      continue;
    }
    if (entry && (m = /^Date\s*[:\-]\s*(.*)$/i.exec(t))) {
      entry.apptDateIso = ddmmyyToISO(m[1].trim()) || (/^\d{4}-\d{2}-\d{2}$/.test(m[1].trim()) ? m[1].trim() : "");
      entry.apptDateRaw = m[1].trim();
      entry.rawBlock.push(line);
      continue;
    }
    if (entry && (m = /^(?:Time|Last visit)\s*[:\-]\s*(.*)$/i.exec(t))) { entry.apptTime = m[1].trim(); entry.rawBlock.push(line); continue; }

    // Foreign entry starts: a numbered person line, a rank+name line, or any
    // line carrying a plausible standalone 4D. The bare-4D path must NOT fire
    // on time-of-day tokens — "latest version as of 110726 @ 0745 Hrs" would
    // otherwise mint a phantom person "0745" — so lines with time/date
    // markers only count when a rank token vouches for them.
    const timeish = /@|\bHrs\b|\bas of\b|\d{6}/i.test(t);
    if ((m = /^\d+[.)]\s+(.*)$/.exec(t)) && (pcFind4d(m[1]) || PC_RANK_RE.test(m[1]))) {
      out.personishLines++;
      startEntry(m[1], line);
      continue;
    }
    if ((pcFind4d(t) && !timeish) || (PC_RANK_RE.test(t) && /^[A-Z0-9 .,'\/\-]+$/.test(t))) {
      out.personishLines++;
      startEntry(t, line);
      continue;
    }

    if (entry) { entry.rawBlock.push(line); continue; }        // free text inside a block
    out.unparsed.push(t);
  }
  finishEntry();

  // Bridge name-keyed people to a 4D via the roster (commanders print without
  // a 4D; foreign pastes abbreviate). Read-only + guarded so the parser stays
  // pure enough for the vm harness without a seeded STATE.
  const roster = (typeof STATE !== "undefined" && Array.isArray(STATE.roster)) ? STATE.roster : [];
  if (roster.length) {
    const byName = {};
    roster.forEach(r => { const n = normalizeParadeName(r.name); if (n) byName[n] = byName[n] === undefined ? r : null; });  // null = ambiguous
    out.people.forEach(p => {
      if (p.d4 || !p.name) return;
      const hit = byName[p.name];
      if (hit) { p.d4 = String(hit.id).replace(/^C/i, ""); p.key = "d4:" + p.d4; }
    });
  }

  Object.keys(out.sectionCounts).forEach(sec => {
    const c = out.sectionCounts[sec];
    if (c.claimed !== null && c.claimed !== c.actual) {
      out.warnings.push(`${PC_SECTION_LABELS[sec] || sec} header claims ${c.claimed} but ${c.actual} ${c.actual === 1 ? "entry" : "entries"} parsed`);
    }
  });
  out.confidence = (out.header.type && canonicalSections >= 2) ? "ours" : "foreign";
  return out;
}

// ─── diffLines(a, b) ────────────────────────────────────
// Classic LCS line diff → [{type:"same"|"add"|"del", line}]. Parade states
// are 100-250 lines, so the O(n·m) table is trivial; the caps below guard
// against someone pasting a whole chat export on a phone.
const PC_DIFF_MAX_LINES = 1500;

function diffLines(aLines, bLines) {
  const a = aLines.slice(0, PC_DIFF_MAX_LINES), b = bLines.slice(0, PC_DIFF_MAX_LINES);
  const n = a.length, mLen = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(mLen + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = mLen - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < mLen) {
    if (a[i] === b[j]) { out.push({ type: "same", line: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ type: "del", line: a[i] }); i++; }
    else { out.push({ type: "add", line: b[j] }); j++; }
  }
  while (i < n) out.push({ type: "del", line: a[i++] });
  while (j < mLen) out.push({ type: "add", line: b[j++] });
  if (aLines.length > PC_DIFF_MAX_LINES || bLines.length > PC_DIFF_MAX_LINES) {
    out.push({ type: "same", line: `… diff truncated at ${PC_DIFF_MAX_LINES} lines` });
  }
  return out;
}

// Normalized lines for the raw diff: trailing space trimmed, separator rows
// and blank runs collapsed so hand-added spacing never shows as a change.
function pcDiffLinesOf(text) {
  return String(text || "").split(/\r?\n/)
    .map(l => l.replace(/\s+$/, ""))
    .filter(l => !/^[-–—=_*]{5,}$/.test(l.trim()))
    .filter((l, idx, arr) => l.trim() !== "" || (arr[idx - 1] || "").trim() !== "");
}

// ─── diffParadeStates(oldParsed, newParsed) ─────────────
// Person-level diff over a GLOBAL key map (never per-section): a move within
// the medical trio is ONE event. Statuses compare as an order-insensitive
// set by family. Zero live-STATE reads — both sides are self-contained.
function diffParadeStates(oldParsed, newParsed, opts) {
  opts = opts || {};
  const res = {
    strength: { total: null, current: null, platoons: {}, commanders: null },
    people: { added: [], removed: [], changed: [], unchangedCount: 0 },
    warnings: [].concat(oldParsed.warnings || [], newParsed.warnings || []),
    sharedSections: [],
    bestEffort: oldParsed.confidence === "foreign" || newParsed.confidence === "foreign",
    structuredOk: false,
    textDiff: (opts.oldText != null && opts.newText != null)
      ? diffLines(pcDiffLinesOf(opts.oldText), pcDiffLinesOf(opts.newText))
      : null
  };

  // Strength deltas only where BOTH sides parsed a number — a one-sided
  // value must never render as a bogus ±N.
  const num = (a, b) => (a != null && b != null) ? { old: a, new: b, delta: b - a } : null;
  res.strength.total = num(oldParsed.strength.total, newParsed.strength.total);
  res.strength.current = num(oldParsed.strength.current, newParsed.strength.current);
  const pltKeys = new Set(Object.keys(oldParsed.strength.platoons).concat(Object.keys(newParsed.strength.platoons)));
  pltKeys.forEach(p => {
    const o = oldParsed.strength.platoons[p], n = newParsed.strength.platoons[p];
    if (o && n) res.strength.platoons[p] = { old: o, new: n, deltaIn: n.in - o.in };
  });
  const oc = oldParsed.strength.commanders, nc = newParsed.strength.commanders;
  if (oc && nc) res.strength.commanders = { old: oc, new: nc, deltaIn: nc.in - oc.in };

  // Compare only sections present on BOTH sides (headers count even when
  // empty) — pasting a MED-only list against a full FP must not report the
  // whole of ATTC/OTHERS as "removed".
  const shared = {};
  Object.keys(oldParsed.sectionsSeen || {}).forEach(s => { if (newParsed.sectionsSeen && newParsed.sectionsSeen[s]) shared[s] = true; });
  // A side with entries but no recognized headers (foreign) exposes the
  // sections its entries landed in, so intersect on those too.
  const secsOf = parsed => {
    const set = Object.assign({}, parsed.sectionsSeen || {});
    (parsed.people || []).forEach(p => { set[p.section] = true; });
    return set;
  };
  if (!Object.keys(shared).length) {
    const a = secsOf(oldParsed), b = secsOf(newParsed);
    Object.keys(a).forEach(s => { if (b[s]) shared[s] = true; });
  }
  res.sharedSections = Object.keys(shared);
  const oldSecs = secsOf(oldParsed), newSecs = secsOf(newParsed);
  const skippedSections = Object.keys(oldSecs).concat(Object.keys(newSecs))
    .filter((s, i, arr) => arr.indexOf(s) === i && !shared[s]);
  if (skippedSections.length) {
    res.warnings.push("Only sections present in both texts were compared — skipped: " +
      skippedSections.map(s => PC_SECTION_LABELS[s] || s).join(", "));
  }

  // key → section → [entries], restricted to shared sections. A LIST per
  // (person, section) because our own generator legitimately emits several
  // blocks for one person in one section — one MEDICAL APPT block per
  // upcoming appointment — and collapsing them made a resolved appointment
  // vanish from the diff and a newly booked one read as a phantom edit.
  const index = parsed => {
    const map = new Map();
    (parsed.people || []).forEach(p => {
      if (!p.key || !shared[p.section]) return;
      if (!map.has(p.key)) map.set(p.key, new Map());
      const bySec = map.get(p.key);
      if (!bySec.has(p.section)) bySec.set(p.section, []);
      bySec.get(p.section).push(p);
    });
    return map;
  };
  const oldMap = index(oldParsed), newMap = index(newParsed);

  const keys = new Set([...oldMap.keys(), ...newMap.keys()]);
  keys.forEach(key => {
    const o = oldMap.get(key) || new Map();
    const n = newMap.get(key) || new Map();
    const pairs = [];      // [oldEntry|null, newEntry|null]
    const oPaired = new Set(), nPaired = new Set();
    // 1. Same-section pairing: dated entries (appointments) match by their
    // Date line; undated leftovers pair in order; a lone leftover on each
    // side still pairs (a single rescheduled appt reads as a date edit, but
    // two disjoint appointments never cross-pair into phantom edits).
    o.forEach((oList, sec) => {
      if (!n.has(sec)) return;
      const nList = n.get(sec);
      const dk = e => e.apptDateIso || e.apptDateRaw || "";
      oList.forEach(oe => {
        if (!dk(oe)) return;
        const ne = nList.find(x => !nPaired.has(x) && dk(x) === dk(oe));
        if (ne) { pairs.push([oe, ne]); oPaired.add(oe); nPaired.add(ne); }
      });
      const oU = oList.filter(e => !oPaired.has(e) && !dk(e));
      const nU = nList.filter(e => !nPaired.has(e) && !dk(e));
      for (let i = 0; i < Math.min(oU.length, nU.length); i++) {
        pairs.push([oU[i], nU[i]]); oPaired.add(oU[i]); nPaired.add(nU[i]);
      }
      const oRest = oList.filter(e => !oPaired.has(e));
      const nRest = nList.filter(e => !nPaired.has(e));
      if (oRest.length === 1 && nRest.length === 1) {
        pairs.push([oRest[0], nRest[0]]); oPaired.add(oRest[0]); nPaired.add(nRest[0]);
      }
    });
    // 2. Leftovers inside the trio cross-pair as a section MOVE.
    const trioLeft = (m, paired) => PC_TRIO.reduce((acc, s) => acc.concat((m.get(s) || []).filter(e => !paired.has(e))), []);
    const oTrio = trioLeft(o, oPaired), nTrio = trioLeft(n, nPaired);
    while (oTrio.length && nTrio.length) {
      const oe = oTrio.shift(), ne = nTrio.shift();
      pairs.push([oe, ne]); oPaired.add(oe); nPaired.add(ne);
    }
    // 3. Remaining one-sided entries.
    o.forEach(list => list.forEach(oe => { if (!oPaired.has(oe)) pairs.push([oe, null]); }));
    n.forEach(list => list.forEach(ne => { if (!nPaired.has(ne)) pairs.push([null, ne]); }));

    pairs.forEach(([oe, ne]) => {
      if (oe && !ne) { res.people.removed.push({ entry: oe, direction: PC_OUT_SECTIONS[oe.section] ? "in" : "info" }); return; }
      if (!oe && ne) { res.people.added.push({ entry: ne, direction: PC_OUT_SECTIONS[ne.section] ? "out" : "info" }); return; }
      const changes = pcEntryChanges(oe, ne);
      if (changes.length) res.people.changed.push({ key, old: oe, new: ne, changes });
      else res.people.unchangedCount++;
    });
  });

  // Sort groups by section prominence then name, so ATTC news leads.
  const secRank = e => ["ATTC", "REPORT_SICK", "MEDICAL_STATUS", "MEDICAL_APPT", "OTHERS", "UNKNOWN"].indexOf(e.section);
  res.people.added.sort((a, b) => secRank(a.entry) - secRank(b.entry) || String(a.entry.name).localeCompare(String(b.entry.name)));
  res.people.removed.sort((a, b) => secRank(a.entry) - secRank(b.entry) || String(a.entry.name).localeCompare(String(b.entry.name)));
  res.people.changed.sort((a, b) => secRank(a.new) - secRank(b.new) || String(a.new.name).localeCompare(String(b.new.name)));

  // Soft sanity note: parsed CURRENT delta vs implied person movements
  // (out-of-camp sections only). Hand edits legitimately break this.
  if (res.strength.current) {
    const outFlag = m => { let f = false; m.forEach((e, s) => { if (PC_OUT_SECTIONS[s]) f = true; }); return f; };
    let implied = 0;
    keys.forEach(key => {
      const was = oldMap.has(key) && outFlag(oldMap.get(key));
      const is = newMap.has(key) && outFlag(newMap.get(key));
      if (was && !is) implied++;
      if (!was && is) implied--;
    });
    if (implied !== res.strength.current.delta) {
      res.warnings.push(`CURRENT STRENGTH moved ${res.strength.current.delta >= 0 ? "+" : ""}${res.strength.current.delta} but listed movements imply ${implied >= 0 ? "+" : ""}${implied} — text may be hand-edited`);
    }
  }

  // Structured-view gate: enough of both sides understood to trust cards.
  const okSide = p => (p.people || []).length >= 1 &&
    ((p.personishLines || 0) === 0 || (p.people || []).length >= (p.personishLines || 0) * 0.5);
  const anyCanonical = p => Object.keys(p.sectionsSeen || {}).some(s => s !== "UNKNOWN");
  const hasAnyPeople = (oldParsed.people || []).length + (newParsed.people || []).length > 0;
  // Both sides empty-of-people is fine when both parse as ours (a quiet day).
  res.structuredOk = hasAnyPeople
    ? ((anyCanonical(oldParsed) || anyCanonical(newParsed)) &&
       ((oldParsed.people || []).length ? okSide(oldParsed) : oldParsed.confidence === "ours") &&
       ((newParsed.people || []).length ? okSide(newParsed) : newParsed.confidence === "ours"))
    : (oldParsed.confidence === "ours" && newParsed.confidence === "ours");
  return res;
}

// Field-level changes between two entries for the same person.
function pcEntryChanges(oe, ne) {
  const changes = [];
  const norm = s => String(s || "").trim().toUpperCase();
  if (oe.section !== ne.section) {
    changes.push({ field: "section", kind: "moved", old: PC_SECTION_LABELS[oe.section] || oe.section, new: PC_SECTION_LABELS[ne.section] || ne.section });
  }
  if (norm(oe.reason) !== norm(ne.reason) && (oe.reason || ne.reason)) {
    changes.push({ field: "reason", kind: "edited", old: oe.reason || "(none)", new: ne.reason || "(none)" });
  }
  if (norm(oe.location) !== norm(ne.location) && (oe.location || ne.location)) {
    changes.push({ field: "location", kind: "edited", old: oe.location || "(none)", new: ne.location || "(none)" });
  }
  if ((oe.apptDateRaw || ne.apptDateRaw) && norm(oe.apptDateRaw) !== norm(ne.apptDateRaw)) {
    changes.push({ field: "date", kind: "edited", old: oe.apptDateRaw || "(none)", new: ne.apptDateRaw || "(none)" });
  }
  if ((oe.apptTime || ne.apptTime) && norm(oe.apptTime) !== norm(ne.apptTime)) {
    changes.push({ field: "time", kind: "edited", old: oe.apptTime || "(none)", new: ne.apptTime || "(none)" });
  }

  // Status SET compare by family — renumbering/reordering is a no-op; an MC
  // extension logged as a second record shows as extended, not added+removed.
  const statusLabel = s => (s.days ? `${s.days}D ` : "") + (s.family || s.raw || "status") +
    (s.startIso ? ` (${s.startIso}${s.endIso ? " – " + s.endIso : ""})` : "");
  const byFamily = list => {
    const m = new Map();
    (list || []).forEach(s => { const f = s.family || s.raw || "?"; if (!m.has(f)) m.set(f, []); m.get(f).push(s); });
    return m;
  };
  const of = byFamily(oe.statuses), nf = byFamily(ne.statuses);
  const fams = new Set([...of.keys(), ...nf.keys()]);
  fams.forEach(f => {
    const os = of.get(f), ns = nf.get(f);
    if (os && !ns) { changes.push({ field: "status", kind: "removed", old: statusLabel(os[0]), new: "" }); return; }
    if (!os && ns) { changes.push({ field: "status", kind: "added", old: "", new: statusLabel(ns[0]) }); return; }
    // Same family both sides: compare the latest record of each.
    const last = list => list.reduce((a, b) => ((b.endIso || "") > (a.endIso || "") ? b : a), list[0]);
    const olast = last(os), nlast = last(ns);
    if (olast.endIso && nlast.endIso && olast.endIso !== nlast.endIso) {
      const dayDelta = Math.round((new Date(nlast.endIso) - new Date(olast.endIso)) / 86400000);
      changes.push({
        field: "status", kind: dayDelta > 0 ? "extended" : "shortened",
        old: statusLabel(olast), new: statusLabel(nlast),
        note: dayDelta > 0 ? `+${dayDelta}D` : `${dayDelta}D`
      });
    } else if (olast.inCamp !== nlast.inCamp) {
      changes.push({
        field: "status", kind: "edited", old: olast.raw || statusLabel(olast), new: nlast.raw || statusLabel(nlast),
        note: nlast.inCamp ? "now counted present in camp" : "no longer in camp"
      });
    } else if ((olast.days || null) !== (nlast.days || null) && olast.days && nlast.days) {
      changes.push({ field: "status", kind: "edited", old: statusLabel(olast), new: statusLabel(nlast) });
    }
  });
  return changes;
}

// ─── Snapshot row normalization ─────────────────────────
// ParadeStates sheet rows are {id, type, savedAt, json} where json packs
// {dateIso, time, text}. The JSON cell's leading "{" defeats Sheets'
// number/date coercion AND formula injection (raw sheet.appendRow writes
// values verbatim — a cell starting with "=" would become a live formula).
// Normalize defensively anyway: legacy/hand-made rows may carry plain
// columns, a Date-coerced dateIso ("11 Jul 2026") or a numeric time (700).
function normalizeParadeSnapshotRow(r) {
  if (!r) return null;
  let meta = {};
  if (r.json) {
    // Guard the parse RESULT too: JSON.parse("null") succeeds and returns
    // null, which would throw on meta.dateIso below.
    try { const p = JSON.parse(String(r.json)); if (p && typeof p === "object") meta = p; } catch { /* meta stays {} */ }
  }
  const dateRaw = String(meta.dateIso ?? r.dateIso ?? "");
  const timeRaw = String(meta.time ?? r.time ?? "");
  const out = {
    id: String(r.id || ""),
    type: (String(r.type || meta.type || "FP").toUpperCase() === "LP") ? "LP" : "FP",
    dateIso: /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw
      : (typeof displayDateToISO === "function" ? (displayDateToISO(dateRaw) || "") : ""),
    time: timeRaw.replace(/\D/g, "").padStart(4, "0").slice(0, 4),
    savedAt: Number(r.savedAt) || 0,
    text: String(meta.text ?? r.text ?? "")
  };
  return (out.id && out.text) ? out : null;
}

// ─── Plain-text change summary (for WhatsApp) ───────────
// Mirrors parade-state typography so the "changes since last parade" message
// can be pasted straight into the group chat.
function compareSummaryText(diff, oldLabel, newLabel) {
  const L = [];
  L.push("PARADE STATE CHANGES");
  L.push(`${oldLabel} -> ${newLabel}`);
  L.push("");
  const s = diff.strength;
  if (s.current) L.push(`CURRENT STRENGTH: ${s.current.old} -> ${s.current.new} (${s.current.delta >= 0 ? "+" : ""}${s.current.delta})`);
  Object.keys(s.platoons).forEach(p => {
    const d = s.platoons[p];
    if (d.deltaIn) L.push(`PLATOON ${p}: ${d.old.in}/${d.old.total} -> ${d.new.in}/${d.new.total}`);
  });
  if (s.commanders && s.commanders.deltaIn) L.push(`COMMANDERS: ${s.commanders.old.in}/${s.commanders.old.total} -> ${s.commanders.new.in}/${s.commanders.new.total}`);
  if (L[L.length - 1] !== "") L.push("");

  const rn = e => e.rnRaw || [e.name, e.d4 ? "C" + e.d4 : ""].filter(Boolean).join(" ");
  const secL = e => PC_SECTION_LABELS[e.section] || e.section;
  if (diff.people.added.length) {
    L.push(`NEWLY LISTED (${diff.people.added.length}):`);
    diff.people.added.forEach((a, i) => {
      L.push(`${i + 1}. ${rn(a.entry)} - ${secL(a.entry)}`);
      if (a.entry.reason) L.push(`Reason: ${a.entry.reason}`);
      a.entry.statuses.forEach(st => { if (st.raw) L.push(`Status: ${st.raw}`); });
    });
    L.push("");
  }
  if (diff.people.removed.length) {
    L.push(`NO LONGER LISTED (${diff.people.removed.length}):`);
    diff.people.removed.forEach((r, i) => L.push(`${i + 1}. ${rn(r.entry)} (was ${secL(r.entry)})`));
    L.push("");
  }
  if (diff.people.changed.length) {
    L.push(`CHANGED (${diff.people.changed.length}):`);
    diff.people.changed.forEach((c, i) => {
      L.push(`${i + 1}. ${rn(c.new)}`);
      c.changes.forEach(ch => {
        if (ch.field === "section") L.push(`${ch.old} -> ${ch.new}`);
        else L.push(`${ch.field.charAt(0).toUpperCase() + ch.field.slice(1)}: ${ch.old || "-"} -> ${ch.new || "-"}${ch.note ? ` (${ch.note})` : ""}`);
      });
    });
    L.push("");
  }
  if (!diff.people.added.length && !diff.people.removed.length && !diff.people.changed.length) {
    L.push("NO CHANGES.");
  }
  return L.join("\n").replace(/\n+$/, "");
}
