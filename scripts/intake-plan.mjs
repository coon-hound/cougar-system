// ============================================================================
// intake-plan.mjs — deciding who is who, and what moves where.
//
// The whole changeover reduces to one judgement call repeated ~300 times: is
// this name on the incoming nominal roll somebody we have seen before? Get it
// right and a recoursee keeps their injury history. Get it wrong in one
// direction and that history is lost; wrong in the other and two people's
// medical records are merged, which is worse.
//
// So that judgement lives here, alone, with no database and no I/O. Everything
// arrives in one argument and everything leaves in the return value, which
// makes the interesting part exhaustively testable (test/intake.test.js) and
// makes the driver (intake-migrate.mjs) a dumb executor of a plan it did not
// author.
//
// NOTHING HERE IS ALLOWED TO GUESS SILENTLY. Every match carries the tier that
// produced it; anything below an exact match is either reported for human
// confirmation or refuses to proceed. See TIER.
// ============================================================================

// ── Names ───────────────────────────────────────────────────────────────────

// Particles that carry no identifying information. Dropped before comparison so
// "MUHAMMAD BIN ALI" and "MUHAMMAD B. ALI" agree, as do "RAJU S/O KUMAR" and
// "RAJU KUMAR". Single letters are dropped wholesale by the length filter,
// which also takes care of initials.
const PARTICLES = new Set(["bin", "binte", "binti", "bte", "so", "do", "al", "ap"]);

export function nameTokens(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2 && !PARTICLES.has(t));
}

// Order-independent identity key: the SORTED, de-duplicated token set.
//
// Sorting is the load-bearing part. Chinese names are recorded in either order
// depending on which system produced the document — "TAN WEI MING" on one roll,
// "WEI MING TAN" on the next — and a positional comparison calls those two
// different people. Must stay in step with person_name_key() in
// supabase/migrations/0004_intake.sql.
export function nameKey(name) {
  return [...new Set(nameTokens(name))].sort().join(" ");
}

// Overlap as a fraction of the SHORTER name, so "TAN WEI MING" against
// "TAN WEI MING RYAN" scores 1.0 rather than 0.75 — a roll that adds or drops a
// given name is the common case, not a different person.
export function nameSimilarity(a, b) {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.min(ta.size, tb.size);
}

export function sharedTokens(a, b) {
  const tb = new Set(nameTokens(b));
  let hits = 0;
  for (const t of new Set(nameTokens(a))) if (tb.has(t)) hits++;
  return hits;
}

// Canonical 4D, identical to padD4 (js/state.js) and the Edge Function's copy:
// strip a leading "C", left-pad 1-3 digits to 4. Anything else passes through,
// which is what keeps archive keys ("1101@25-08") intact.
export function padD4(v) {
  const s = String(v ?? "").trim().replace(/^C/i, "");
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
}

// Mirrors archive_key() in 0004_intake.sql. Duplicated rather than called
// through SQL so the plan can be computed, printed and diffed with no database
// connection at all.
export function archiveKey(d4, intake) {
  const s = String(d4 ?? "");
  if (!s) return s;
  if (s.includes("@")) return s;
  return `${s}@${String(intake ?? "unknown").replace(/\//g, "-")}`;
}

// ── Reading a nominal roll ──────────────────────────────────────────────────

// Header spellings we accept, compared with case and punctuation stripped. HQ
// rolls arrive as whatever the last clerk typed, and renaming columns by hand
// before every changeover is exactly the kind of manual step that eventually
// gets done wrong at 2am.
const ALIASES = {
  d4: ["4d", "d4", "4d number", "4d no", "id", "recruit id", "coy id", "seat"],
  name: ["name", "full name", "name of personnel", "recruit name", "personnel name", "nric name"],
  rank: ["rank", "rk"],
  plt: ["plt", "platoon", "pl"],
  sect: ["sect", "section", "sec"],
  pid: ["pid", "person id", "permanent id"],
  nric: ["nric", "nric no", "nric last 4", "last 4 nric", "nric suffix", "id no"],
  phone: ["phone", "hp", "mobile", "contact", "contact no", "hp no"],
  email: ["email", "email address", "mail"],
  dob: ["dob", "date of birth", "birth date"],
  bloodType: ["blood type", "blood group", "bloodtype"],
  allergies: ["allergies", "allergy"],
  otherMedical: ["other medical", "medical conditions", "medical history", "pes remarks"],
  address: ["address", "home address", "residential address"],
  nokName: ["nok name", "next of kin", "next of kin name", "nok"],
  nokRelation: ["nok relation", "nok relationship", "relationship"],
  nokPhone: ["nok phone", "nok contact", "nok hp", "next of kin contact"],
  height: ["height", "height cm"],
  weight: ["weight", "weight kg"],
  ration: ["ration", "diet", "dietary"],
  program: ["program", "programme", "training program"],
  remarks: ["remarks", "remark", "notes", "note"],
};

const canon = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADER_LOOKUP = (() => {
  const m = new Map();
  for (const [field, spellings] of Object.entries(ALIASES)) {
    for (const s of spellings) m.set(canon(s), field);
  }
  return m;
})();

/**
 * Map one raw roll row onto canonical field names.
 *
 * Unrecognised columns are DROPPED rather than preserved. The schema comment in
 * 0001 is explicit that fields which drive no decision do not get stored, and a
 * roll routinely carries a dozen of them (vocation codes, bunk numbers, parent
 * occupation). Keeping them would quietly undo that minimisation by filling
 * `extra` with whatever HQ happened to send.
 */
export function normaliseRollRow(raw) {
  const out = {};
  const unknown = [];
  for (const [h, v] of Object.entries(raw ?? {})) {
    const field = HEADER_LOOKUP.get(canon(h));
    if (!field) {
      if (String(h ?? "").trim()) unknown.push(String(h).trim());
      continue;
    }
    const val = v == null ? "" : String(v).trim();
    if (!out[field]) out[field] = val;
  }
  return { row: out, unknown };
}

/**
 * Minimal RFC4180 CSV reader: quoted fields, embedded commas, doubled quotes,
 * CRLF. Deliberately not a dependency — the alternative is adding a parser to a
 * repo whose whole frontend is dependency-free, to read one file once a year.
 */
export function parseCsv(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", quoted = false, i = 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { endField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endRow(); i++; continue; }
    field += c; i++;
  }
  // A trailing newline leaves an empty pending row; anything else is real data
  // that must not be dropped.
  if (field.length || row.length) endRow();

  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim()))
    .map((r) => Object.fromEntries(headers.map((h, n) => [h, r[n] ?? ""])));
}

/**
 * The last four characters of an NRIC — three digits and the checksum letter,
 * e.g. "123A". Only ever used to seed a digest, never stored.
 *
 * Exactly three digits, not three-or-four. An NRIC is a letter, seven digits
 * and a letter, so "the last 4" is unambiguously \d{3}[A-Z]; allowing four
 * digits makes the pattern greedy and yields "2123A" from S9912123A, which
 * would then not match the same person's "123A" on a roll that supplied only
 * the suffix. Accepts a full NRIC or a bare suffix, and gives the same key for
 * both — which is the whole point.
 */
export function nricKey(nric) {
  const s = String(nric ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const m = s.match(/(\d{3}[A-Z])$/);
  return m ? m[1] : "";
}

// ── Carry rules ─────────────────────────────────────────────────────────────

/**
 * What happens to each table at a changeover.
 *
 *   "person"    rows belonging to a matched returnee are COPIED onto their new
 *               4D and stay live; the originals archive with everyone else's.
 *   "future"    the same, but only rows dated on or after the cutoff.
 *   "commander" recruit rows archive, commander (00xx) rows stay untouched.
 *   "none"      archived wholesale.
 *   "keep"      not touched at all.
 *
 * The line between "person" and "none" is whether the record describes the
 * HUMAN or the COHORT.
 *
 * Medical and MSK are clinical and follow the human — a recoursee's recurring
 * ankle injury is the single most valuable thing in the database and the reason
 * this script exists. IPPT, route march and SOC are a fitness baseline and a
 * trend; carrying them means a returnee's first IPPT is compared against his
 * own previous one instead of appearing out of nowhere.
 *
 * Attendance, ConductDetail and PolarFlow are records of specific conducts on
 * specific dates that the incoming cohort did not attend. Carrying them would
 * corrupt exactly the numbers the dashboard exists to report — strength,
 * participation, LMS counts — so they archive even for a returnee.
 *
 * Commanders are not part of an intake at all. They keep their leave rows
 * because off-in-lieu balances are earned by the person and must not reset when
 * the recruits under them change.
 */
export const CARRY_RULES = {
  medical: { table: "medical", tab: "Medical", carry: "person", dateField: "startDate" },
  msk: { table: "msk", tab: "MSK", carry: "person", dateField: "timestamp", noId: true },
  ippt: { table: "ippt", tab: "IPPT", carry: "person", dateField: "date" },
  rm: { table: "routemarch", tab: "RouteMarch", carry: "person", dateField: "date" },
  soc: { table: "soc", tab: "SOC", carry: "person", dateField: "date" },
  appointments: { table: "appointments", tab: "Appointments", carry: "future", dateField: "date" },
  leave: { table: "leave", tab: "Leave", carry: "commander", dateField: "startDate" },
  attendance: { table: "attendance", tab: "Attendance", carry: "none" },
  conductDetail: { table: "conductdetail", tab: "ConductDetail", carry: "none" },
  polar: { table: "polarflow", tab: "PolarFlow", carry: "none" },
  conducts: { table: "conducts", tab: "Conducts", carry: "keep" },
};

/** Match confidence, most to least trusted. */
export const TIER = {
  OVERRIDE: "override",   // a human said so                              → auto
  PID: "pid",             // roll carried a pid we already know           → auto
  NRIC: "nric",           // NRIC digest matched                          → auto
  NAME: "name",           // exact token-set match, one candidate         → auto
  FUZZY: "fuzzy",         // partial name match, one candidate            → warn
  AMBIGUOUS: "ambiguous", // more than one candidate                      → block
  NEW: "new",             // nobody matched                               → auto
};

// A fuzzy match needs both: nearly all of the shorter name in common AND at
// least two real tokens. Either alone is far too loose — one shared surname is
// a third of the company, and two-token names would match on a single token at
// 0.5.
//
// 0.8 rather than the obvious 0.6, which a rehearsal against seeded data showed
// to be actively dangerous: "JOSHUA LIM KAI EN" scored 0.67 against "KAI XIN
// LIM" on the strength of {lim, kai} and would have inherited a stranger's
// medical history. Singaporean names draw heavily on a small pool of tokens
// (LIM, TAN, WEI, KAI, JUN), so two of them in common means very little. At 0.8
// the only things that still match are a name that gained or lost ONE part —
// "TAN WEI MING" against "TAN WEI MING RYAN" — which is the real case this tier
// exists for.
const FUZZY_MIN_SIMILARITY = 0.8;
const FUZZY_MIN_TOKENS = 2;

// ── Dates ───────────────────────────────────────────────────────────────────
//
// Rows store dates as the display string the Sheets backend produced
// ("16 May 2026"); forms also write plain ISO. Both are accepted and compared
// as ISO. An unparseable date returns "" and is treated as "no date", which for
// the `future` rule means the row is not carried — the conservative direction,
// since a stale appointment is worse than a missing one.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function toISO(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return "";
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi < 0) return "";
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export function addDays(iso, n) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function displayDate(iso) {
  const [y, m, d] = String(iso).split("-");
  if (!y || !m || !d) return String(iso);
  const mon = MONTHS[Number(m) - 1] ?? "";
  return `${d} ${mon.charAt(0).toUpperCase()}${mon.slice(1)} ${y}`;
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * Produce every write the changeover will perform, and nothing else.
 *
 * @param {object} ctx
 * @param {string} ctx.label     new intake label, e.g. "26/02"
 * @param {string} ctx.prevLabel label the OUTGOING cohort is archived under
 * @param {string} ctx.cutoff    YYYY-MM-DD, the new cohort's first day
 * @param {(s:string)=>string} ctx.hash  keyed digest; injected so this file
 *                               never imports crypto and never sees the key
 * @param {object[]} ctx.roll    raw nominal-roll rows (roll headers as keys)
 * @param {object[]} ctx.people  existing `people` rows
 * @param {object[]} ctx.roster  current roster rows (live only)
 * @param {object}   ctx.data    { medical, msk, ippt, rm, soc, appointments, leave }
 * @param {object}   ctx.overrides  { "<new 4D>": "<pid>" | "NEW" }
 * @param {boolean}  ctx.acceptFuzzy  downgrade fuzzy matches from blocking to a
 *                               warning. For the operator who has read every
 *                               one of them and agrees; never the default.
 */
export function planIntake(ctx) {
  const label = String(ctx.label ?? "").trim();
  const prevLabel = String(ctx.prevLabel ?? "").trim();
  const cutoff = String(ctx.cutoff ?? "");
  const overrides = ctx.overrides ?? {};
  const acceptFuzzy = ctx.acceptFuzzy === true;
  const hash = ctx.hash ?? ((s) => String(s));
  const issues = [];
  const err = (line, msg) => issues.push({ level: "error", line, msg });
  const warn = (line, msg) => issues.push({ level: "warn", line, msg });

  // ── 1. Normalise and validate the roll ────────────────────────────────
  const rows = [];
  const seenD4 = new Map();
  const unknownHeaders = new Set();

  (ctx.roll ?? []).forEach((raw, idx) => {
    const line = idx + 2;                     // row 1 is headers; humans count from 1
    const { row: r, unknown } = normaliseRollRow(raw);
    unknown.forEach((u) => unknownHeaders.add(u));

    const d4 = padD4(r.d4);
    const name = String(r.name ?? "").trim();
    if (!d4 && !name) return;                 // blank spacer row

    if (!d4) return err(line, `Row ${line} ("${name}") has no 4D.`);
    if (!/^\d{4}$/.test(d4)) return err(line, `Row ${line}: 4D "${d4}" is not four digits.`);
    if (/^00/.test(d4)) {
      return err(line, `Row ${line}: 4D ${d4} is in the 00xx commander range. Recruits are 1000 and above.`);
    }
    if (!name) return err(line, `Row ${line} (4D ${d4}) has no name.`);
    if (!nameTokens(name).length) return err(line, `Row ${line}: name "${name}" has no usable letters.`);
    if (seenD4.has(d4)) {
      return err(line, `Row ${line}: 4D ${d4} is already used on row ${seenD4.get(d4)}.`);
    }
    seenD4.set(d4, line);

    const nk = nricKey(r.nric);
    rows.push({
      ...r,
      nric: undefined,                        // the raw value stops here
      d4,
      name,
      line,
      nameKey: nameKey(name),
      nricHash: nk ? hash(`nric:${nk}`) : "",
    });
  });

  if (!rows.length) err(0, "The nominal roll produced no usable rows.");
  if (unknownHeaders.size) {
    warn(0, `Ignored ${unknownHeaders.size} unrecognised column(s): ${[...unknownHeaders].join(", ")}. ` +
            `Add an alias in intake-plan.mjs if one of these matters.`);
  }

  // ── 2. Index everyone we already know ─────────────────────────────────
  // `people` is the superset — it accumulates every cohort — so somebody who
  // left two intakes ago is still found. The current roster is folded in on top
  // so the FIRST run, when `people` is empty, still has something to match
  // against.
  const byPid = new Map(), byNric = new Map(), byNameKey = new Map();
  const known = [];
  const takenPids = new Set();

  const remember = (p) => {
    known.push(p);
    takenPids.add(p.pid);
    byPid.set(p.pid, p);
    if (p.nricHash) byNric.set(p.nricHash, p);
    if (p.nameKey) {
      if (!byNameKey.has(p.nameKey)) byNameKey.set(p.nameKey, []);
      byNameKey.get(p.nameKey).push(p);
    }
  };

  const makePid = (seed) => {
    const base = "P" + String(hash(seed)).replace(/[^0-9a-f]/gi, "").slice(0, 10).toUpperCase();
    let pid = base, n = 2;
    while (takenPids.has(pid)) pid = `${base}-${n++}`;
    takenPids.add(pid);
    return pid;
  };

  for (const p of ctx.people ?? []) {
    if (!p?.pid) continue;
    remember({
      pid: String(p.pid),
      name: String(p.name ?? ""),
      nameKey: String(p.name_key ?? p.nameKey ?? nameKey(p.name)),
      nricHash: String(p.nric_hash ?? p.nricHash ?? ""),
      lastD4: padD4(p.last_d4 ?? p.lastD4 ?? ""),
      d4History: Array.isArray(p.d4_history ?? p.d4History) ? [...(p.d4_history ?? p.d4History)] : [],
      firstIntake: String(p.first_intake ?? p.firstIntake ?? ""),
      lastIntake: String(p.last_intake ?? p.lastIntake ?? ""),
    });
  }

  // Outgoing recruits with no pid yet: mint one now so this is the last
  // changeover that has to match them on a name.
  for (const r of ctx.roster ?? []) {
    if (!r) continue;
    const rid = padD4(r.id ?? r["4d"] ?? "");
    if (r.role === "Commander" || /^00\d{2}$/.test(rid)) continue;
    if (r.pid && byPid.has(r.pid)) { byPid.get(r.pid).lastD4 = rid; continue; }

    const nk = nameKey(r.name);
    if (!nk) continue;
    const existing = byNameKey.get(nk);
    if (existing?.length === 1 && !existing[0].lastD4) { existing[0].lastD4 = rid; continue; }
    if (existing?.length) continue;           // already represented in `people`

    remember({
      pid: r.pid && !takenPids.has(r.pid) ? String(r.pid) : makePid(`name:${nk}|seat:${rid}`),
      name: String(r.name ?? ""),
      nameKey: nk,
      nricHash: "",
      lastD4: rid,
      d4History: [rid],
      firstIntake: "",
      lastIntake: prevLabel,
    });
  }

  // ── 3. Match ──────────────────────────────────────────────────────────
  const claimed = new Map();                  // pid → the row that claimed it
  const matches = [];

  for (const row of rows) {
    const m = { d4: row.d4, name: row.name, line: row.line, tier: TIER.NEW, person: null, candidates: [] };
    const ov = overrides[row.d4];

    if (ov && String(ov).toUpperCase() === "NEW") {
      m.note = "forced NEW by override";
    } else if (ov) {
      if (byPid.has(ov)) { m.tier = TIER.OVERRIDE; m.person = byPid.get(ov); }
      else err(row.line, `Override for 4D ${row.d4} names pid "${ov}", which does not exist.`);
    }

    if (!m.person && !m.note) {
      if (row.pid) {
        if (byPid.has(row.pid)) { m.tier = TIER.PID; m.person = byPid.get(row.pid); }
        else warn(row.line, `Row ${row.line} carries pid "${row.pid}", which we have never seen. Treating as a new enlistee.`);
      }
      if (!m.person && row.nricHash && byNric.has(row.nricHash)) {
        m.tier = TIER.NRIC; m.person = byNric.get(row.nricHash);
      }
      if (!m.person && byNameKey.has(row.nameKey)) {
        const exact = byNameKey.get(row.nameKey);
        if (exact.length === 1) { m.tier = TIER.NAME; m.person = exact[0]; }
        else { m.tier = TIER.AMBIGUOUS; m.candidates = [...exact]; }
      }
      if (!m.person && m.tier !== TIER.AMBIGUOUS) {
        const near = known.filter((k) =>
          sharedTokens(row.name, k.name) >= FUZZY_MIN_TOKENS &&
          nameSimilarity(row.name, k.name) >= FUZZY_MIN_SIMILARITY);
        if (near.length === 1) { m.tier = TIER.FUZZY; m.person = near[0]; m.candidates = near; }
        else if (near.length > 1) { m.tier = TIER.AMBIGUOUS; m.candidates = near; }
      }
    }

    // One human cannot hold two seats in the same cohort. When two rows land on
    // the same person BOTH are demoted — resolving it by arrival order would
    // silently give one of them somebody else's medical history.
    if (m.person) {
      const prev = claimed.get(m.person.pid);
      if (prev) {
        m.candidates = [m.person];
        m.person = null;
        m.tier = TIER.AMBIGUOUS;
        if (prev.person) { prev.candidates = [prev.person]; prev.person = null; }
        prev.tier = TIER.AMBIGUOUS;
        err(row.line, `4D ${row.d4} and 4D ${prev.d4} both match the same person. ` +
                      `Set \`pid\` on both rows (use NEW for whichever is not the returnee).`);
      } else {
        claimed.set(m.person.pid, m);
      }
    }

    if (m.tier === TIER.AMBIGUOUS) {
      err(row.line, `4D ${row.d4} (${row.name}) matches ${m.candidates.length} known people. ` +
                    `Set \`pid\` on that row to resolve. Candidates: ` +
                    m.candidates.map((c) => `${c.pid} ${c.name}`).join("; "));
    } else if (m.tier === TIER.FUZZY) {
      // BLOCKING, not a warning. A fuzzy match is a guess about which human a
      // set of medical records belongs to, and the cost of getting it wrong is
      // one recruit silently carrying another's history — invisible afterwards
      // and unsafe. A warning buried among 300 rows is not a decision; an
      // explicit override is.
      const msg =
        `4D ${row.d4} (${row.name}) looks like "${m.person.name}" (${m.person.pid}) but the names ` +
        `do not match exactly. Decide explicitly:\n` +
        `        same person  ->  --override ${row.d4}=${m.person.pid}\n` +
        `        new enlistee ->  --override ${row.d4}=NEW`;
      if (acceptFuzzy) warn(row.line, `Accepted on --accept-fuzzy: ${msg}`);
      else err(row.line, msg);
    }
    matches.push(m);
  }

  // ── 4. The new roster ─────────────────────────────────────────────────
  const byD4 = new Map(rows.map((r) => [r.d4, r]));
  const remap = new Map();                    // old 4D → new 4D (returnees only)
  const returnees = [];
  const newRoster = [];

  // Columns that exist on `roster` (0001) and can be filled from a roll. Listed
  // explicitly rather than spread from the roll so a stray column can never
  // reach the table, and so every row carries an identical key set.
  const ROSTER_FROM_ROLL = [
    "phone", "email", "dob", "bloodType", "allergies", "otherMedical",
    "address", "nokName", "nokRelation", "nokPhone", "height", "weight",
    "ration", "program",
  ];

  for (const m of matches) {
    const src = byD4.get(m.d4);
    if (!src) continue;

    const pid = m.person
      ? m.person.pid
      : makePid(src.nricHash ? `nric:${src.nricHash}` : `name:${src.nameKey}|intake:${label}`);

    if (m.person?.lastD4 && m.person.lastD4 !== src.d4) {
      remap.set(m.person.lastD4, src.d4);
      returnees.push({
        pid, name: src.name, oldD4: m.person.lastD4, newD4: src.d4, tier: m.tier,
      });
    }

    const row = {
      id: src.d4,
      "4d": `C${src.d4}`,                     // display form, as live data holds it
      name: src.name,
      rank: src.rank || "REC",
      role: "Recruit",
      status: "",
      groups: "",
      notes: src.remarks || "",
      leaveQuota: "",
      outOfCamp: "", outReason: "", outSince: "",
      campIn: "", campInSince: "",
      location: "", locationSince: "",
      msk: "", age: "",
      "highest education level": "", "motorcycle license": "",
    };
    for (const f of ROSTER_FROM_ROLL) row[f] = src[f] ?? "";
    newRoster.push({ row, pid, intake: label });
  }

  // ── 5. Carry / archive each table ─────────────────────────────────────
  const commanderIds = new Set(
    (ctx.roster ?? [])
      .filter((r) => r && (r.role === "Commander" || /^00\d{2}$/.test(padD4(r.id ?? r["4d"] ?? ""))))
      .map((r) => padD4(r.id ?? r["4d"] ?? "")),
  );

  const carried = {};       // key → rows to INSERT live under the new 4D
  const archived = [];      // tables archived wholesale
  const clamped = [];
  const movedCounts = new Map();   // pid → { table: n }

  for (const [key, rule] of Object.entries(CARRY_RULES)) {
    if (rule.carry === "keep") continue;
    if (rule.carry === "none") { archived.push(rule.tab); continue; }

    const out = [];
    for (const rec of ctx.data?.[key] ?? []) {
      if (!rec) continue;
      const d4 = padD4(rec.d4);

      if (rule.carry === "commander") {
        // Commander rows are not archived and not copied — they simply stay
        // where they are. Recorded here only so the report can say so.
        if (commanderIds.has(d4)) out.push({ keep: true, id: rec.id });
        continue;
      }

      const newD4 = remap.get(d4);
      if (!newD4) continue;                   // not a returnee: archived, not carried
      if (rule.carry === "future" && cutoff && toISO(rec[rule.dateField]) < cutoff) continue;

      const copy = { ...rec, d4: newD4 };

      // A status still open when the cohort changed would otherwise put a
      // returnee on MC on his first parade state, months after the fact. Close
      // it the day before the cutoff and list it for re-verification; the
      // archived original keeps the real end date.
      if (key === "medical" && cutoff) {
        const end = toISO(copy.endDate);
        if (!end || end >= cutoff) {
          clamped.push({ oldD4: d4, newD4, status: copy.status ?? "", was: copy.endDate || "(open)" });
          copy.endDate = displayDate(addDays(cutoff, -1));
        }
      }

      // A fresh id, because the original row keeps its own and archives under
      // it. Deterministic over (table, source id, new seat, label) so a rerun
      // of the same changeover produces the same ids and stays idempotent.
      // The "i-" prefix matches the importer's "m-" convention: never
      // confusable with a legacy numeric id, and `+id` stays NaN.
      if (!rule.noId) {
        copy.id = "i-" + String(hash(`${rule.table}|${rec.id ?? ""}|${newD4}|${label}`)).slice(0, 12);
      }
      out.push(copy);

      const pid = returnees.find((r) => r.newD4 === newD4)?.pid;
      if (pid) {
        if (!movedCounts.has(pid)) movedCounts.set(pid, {});
        movedCounts.get(pid)[key] = (movedCounts.get(pid)[key] ?? 0) + 1;
      }
    }
    carried[key] = out;
  }

  // ── 6. The people registry ────────────────────────────────────────────
  const people = newRoster.map(({ row, pid }) => {
    const prior = byPid.get(pid);
    const hist = prior ? [...prior.d4History] : [];
    if (!hist.includes(row.id)) hist.push(row.id);
    const src = byD4.get(row.id);
    return {
      pid,
      name: row.name,
      name_key: nameKey(row.name),
      nric_hash: src?.nricHash || prior?.nricHash || null,
      first_intake: prior?.firstIntake || label,
      last_intake: label,
      last_d4: row.id,
      d4_history: hist,
    };
  });

  const blocking = issues.filter((i) => i.level === "error").length;
  const byTier = {};
  for (const m of matches) byTier[m.tier] = (byTier[m.tier] ?? 0) + 1;

  return {
    ok: blocking === 0,
    label,
    prevLabel,
    cutoff,
    matches,
    returnees: returnees.map((r) => ({ ...r, rowsMoved: movedCounts.get(r.pid) ?? {} })),
    remap: Object.fromEntries(remap),
    newRoster,
    carried,
    archived,
    clamped,
    people,
    issues,
    stats: {
      rollRows: rows.length,
      recruits: newRoster.length,
      commanders: commanderIds.size,
      returnees: returnees.length,
      byTier,
      blockingIssues: blocking,
    },
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

/**
 * The report is the product. `preview` prints it and stops; `--apply` prints
 * the same thing and then acts, so what you approved is what ran.
 *
 * Names ARE printed — this is the one output a human has to read to confirm a
 * match, and a report of anonymised ids cannot be checked by anybody. It is not
 * printed alongside dates of birth or next of kin, and nothing sensitive from
 * the roll reaches stdout.
 */
export function formatReport(plan) {
  const L = [];
  const rule = "─".repeat(72);
  L.push(rule);
  L.push(`  INTAKE CHANGEOVER   ${plan.label || "(unlabelled)"}` +
         (plan.prevLabel ? `   archiving ${plan.prevLabel}` : "") +
         (plan.cutoff ? `   cutoff ${plan.cutoff}` : ""));
  L.push(rule);
  L.push("");

  const t = plan.stats.byTier;
  L.push(`ROLL       ${plan.stats.rollRows} rows -> ${plan.stats.recruits} recruits`);
  L.push(`           ${plan.stats.commanders} commanders stay as they are`);
  L.push(`MATCHED    new ${t.new ?? 0}  ·  pid ${t.pid ?? 0}  ·  NRIC ${t.nric ?? 0}  ·  name ${t.name ?? 0}` +
         `  ·  override ${t.override ?? 0}  ·  fuzzy ${t.fuzzy ?? 0}  ·  AMBIGUOUS ${t.ambiguous ?? 0}`);
  L.push("");

  if (plan.returnees.length) {
    L.push(`RETURNEES (${plan.returnees.length}) — records re-homed onto the new seat`);
    for (const r of plan.returnees) {
      const moved = Object.entries(r.rowsMoved).map(([k, n]) => `${k} ${n}`).join(", ") || "no records";
      L.push(`  ${r.oldD4} -> ${r.newD4}  ${r.name}`);
      L.push(`      matched by ${r.tier} · ${r.pid} · moved: ${moved}`);
    }
    L.push("");
  } else {
    L.push("RETURNEES  none — everyone on this roll is new to us.");
    L.push("");
  }

  L.push("TABLES");
  for (const [key, r] of Object.entries(CARRY_RULES)) {
    if (r.carry === "keep") { L.push(`  ${r.tab.padEnd(15)} untouched`); continue; }
    if (r.carry === "none") { L.push(`  ${r.tab.padEnd(15)} archived in full (still queryable by intake)`); continue; }
    if (r.carry === "commander") {
      L.push(`  ${r.tab.padEnd(15)} ${(plan.carried[key] ?? []).length} commander rows kept, recruit rows archived`);
      continue;
    }
    L.push(`  ${r.tab.padEnd(15)} ${(plan.carried[key] ?? []).length} rows carried to new seats, rest archived`);
  }
  L.push("");

  if (plan.clamped.length) {
    L.push(`OPEN MEDICAL STATUSES CLOSED AT CHANGEOVER (${plan.clamped.length}) — re-verify these people`);
    for (const c of plan.clamped) {
      L.push(`  ${c.oldD4} -> ${c.newD4}  ${c.status || "(no status)"}  end was ${c.was}`);
    }
    L.push("");
  }

  const errs = plan.issues.filter((i) => i.level === "error");
  const warns = plan.issues.filter((i) => i.level === "warn");
  if (errs.length) {
    L.push(`BLOCKING (${errs.length}) — fix these in the roll, then preview again`);
    for (const e of errs) L.push(`  * ${e.msg}`);
    L.push("");
  }
  if (warns.length) {
    L.push(`REVIEW (${warns.length}) — will proceed, but read them first`);
    for (const w of warns) L.push(`  * ${w.msg}`);
    L.push("");
  }

  L.push(plan.ok
    ? `READY. Rerun with --apply to perform the changeover.`
    : `NOT READY — ${errs.length} blocking issue(s). Nothing will be written.`);
  return L.join("\n");
}
