#!/usr/bin/env node
// ============================================================================
// Seed the LOCAL dev environment with synthetic data.
//
// Deliberately synthetic. Real personnel records - names, DOB, addresses,
// blood type, medical conditions, next-of-kin - are not copied onto a dev
// machine just to make a UI look populated. The shapes, volumes and ratios
// mirror the live sheet so the app behaves realistically; the people do not
// exist.
//
// EVERY DATE IS RELATIVE TO TODAY. The app is almost entirely date-windowed:
// a recruit is out of camp only while an MC or leave record covers TODAY
// (medStatusActive / derivedCampOut, js/helpers.js:508-556), a manual book-out
// counts only on the day it was set (isBookedOut :528), and the parade state
// is computed for a single date. Fixed calendar dates would go stale the day
// after they were written and every one of those screens would render empty -
// which looks like a broken app rather than an empty day.
//
// To rehearse a migration against real data instead, use
// scripts/migrate-from-sheets.mjs against a staging database, never this.
//
//   node scripts/dev-seed.mjs [--api http://127.0.0.1:8000/] [--token dev-token]
// ============================================================================

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const API = arg("api", "http://127.0.0.1:8000/");
const TOKEN = arg("token", "dev-token");

const post = async (body) => {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ ...body, auth: TOKEN }),
  });
  const out = await res.json();
  if (out.error) throw new Error(`${body.action} ${body.tab}: ${out.error}`);
  return out;
};

// ── Dates ───────────────────────────────────────────────────────────────────
// Two formats travel together and they are not interchangeable:
//   display  "5 Sep 2026"  - every date CELL, matching what Apps Script
//                            formatted sheet dates as (isoToDisplayDate,
//                            js/helpers.js:904 - note: no zero padding)
//   iso      "2026-09-05"  - outSince / campInSince only, which are compared
//                            against todayISO() (js/helpers.js:897)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const d2 = (n) => String(n).padStart(2, "0");

// Row ids are NUMERIC STRINGS on purpose, and that is not cosmetic.
//
// This seed used to mint readable ids like "md-01". They are non-numeric, so
// `+"md-01"` is NaN - falsy - which walks a DIFFERENT branch from production,
// where the old client minted 4-digit counter ids and Postgres hands them back
// as "1404". There `+"1404"` is a truthy NUMBER that then fails `===` against
// the TEXT id on the row, so an edit silently APPENDED a duplicate instead of
// updating in place. Every fixture in the repo hid that bug for exactly this
// reason. Seeding numeric strings keeps the dev backend on the production code
// path (see test/e2e/text-id-edits.spec.js and normId, js/state.js).
//
// One counter per tab, so ids are stable for a given seed run and unique within
// their tab - which is all the backend keys on.
const idSeq = (base) => { let n = 0; return () => String(base + ++n); };
const medId = idSeq(101000), leaveId = idSeq(102000), apptId = idSeq(103000);
const attId = idSeq(104000), detailId = idSeq(105000), polarId = idSeq(106000);
const ipptId = idSeq(107000), rmId = idSeq(108000), socId = idSeq(109000);

const at = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d;
};
const iso = (offsetDays = 0) => {
  const d = at(offsetDays);
  return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}`;
};
const day = (offsetDays = 0) => {
  const d = at(offsetDays);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

// ── Synthetic people ────────────────────────────────────────────────────────
const SURNAMES = ["TAN", "LIM", "LEE", "NG", "WONG", "CHAN", "KUMAR", "RAHMAN",
  "GOH", "TEO", "ONG", "SIM", "YEO", "CHUA", "KOH", "LOW", "ANG", "HO"];
const GIVEN = ["WEI MING", "JUN HAO", "ZHI HAO", "YI XUAN", "JIA JUN", "KAI XIN",
  "ARJUN", "FAIZAL", "RYAN", "MARCUS", "DARREN", "ELROY", "SHAWN", "BENJAMIN"];
const BLOOD = ["O+", "A+", "B+", "AB+", "O-"];
const PROGRAMS = ["PTP", "BMT", "Combined"];
const GROUPS = ["Guard", "Range Party", "Duty Driver"];

const pick = (a, i) => a[i % a.length];

// 3 platoons x 15 = 45 recruits, plus 6 commanders. The live sheet's ratio is
// 256 recruits : 26 commanders; this keeps the shape at a size you can read.
const roster = [];
for (let plt = 1; plt <= 3; plt++) {
  for (let n = 1; n <= 15; n++) {
    const i = roster.length;
    const d4 = `${plt}${d2(n)}`.padStart(4, "0");
    roster.push({
      id: d4, "4d": `C${d4}`,
      name: `${pick(GIVEN, i)} ${pick(SURNAMES, i)}`,
      age: String(18 + (i % 5)),
      status: "Active",          // overwritten below for anyone on a live status
      role: "Recruit",
      rank: "REC",
      program: pick(PROGRAMS, i),
      height: String(165 + (i % 20)),
      weight: String(55 + (i % 25)),
      dob: `${1 + (i % 28)} ${pick(["Jan", "Mar", "Jun", "Sep", "Nov"], i)} 200${5 + (i % 3)}`,
      bloodType: pick(BLOOD, i),
      allergies: i % 7 === 0 ? "peanuts" : "",
      otherMedical: i % 11 === 0 ? "mild asthma" : "",
      phone: `9${String(1000000 + i * 7919).slice(0, 7)}`,
      address: `Blk ${100 + i} Test Ave #${d2(i % 20)}-${d2(i % 99)}`,
      nokName: `MRS ${pick(SURNAMES, i + 3)}`,
      nokRelation: i % 3 === 0 ? "Father" : "Mother",
      nokPhone: `8${String(2000000 + i * 3571).slice(0, 7)}`,
      leaveQuota: "14",
      outOfCamp: "FALSE",
      campIn: "FALSE",
      groups: i % 9 === 0 ? pick(GROUPS, i / 9) : "",
      location: "Camp",
      ration: i % 5 === 0 ? "Halal" : "Normal",
    });
  }
}
for (let c = 1; c <= 6; c++) {
  roster.push({
    id: d2(c).padStart(4, "0"), "4d": d2(c).padStart(4, "0"),
    // The rank is its own column and the UI prefixes it, so the name must not
    // repeat it — otherwise every commander reads "CPT CPT TAN".
    name: `${pick(GIVEN, c + 2)} ${pick(SURNAMES, c + 5)}`, role: "Commander", rank: "CPT",
    status: "Active", outOfCamp: "FALSE", campIn: "FALSE", program: "Combined",
    phone: `9${String(5000000 + c * 131).slice(0, 7)}`,
    // Duty-schedule fields (0009). appt alternates so both OIL rule classes
    // match somebody; leaveQuota is the ANNUAL LEAVE entitlement, and OIL has
    // no quota because it is earned from the rules below. One commander is
    // left untracked on purpose: "appears in the schedule" and "has an off
    // budget" are two different predicates, and the balances view has to keep
    // them apart rather than showing him as a row of zeros.
    appt: c % 2 ? "VC" : "SC",
    oilTracked: c === 6 ? "" : "true",
    leaveQuota: "14", openingOilUsed: c === 1 ? "2.5" : "0", openingAlUsed: "0",
  });
}

const recruits = roster.filter((r) => r.role === "Recruit");
const by = (n) => recruits[n].id;   // nth recruit's 4D, for the scripted cases

// ── Today's picture ─────────────────────────────────────────────────────────
//
// Hand-written rather than generated, because the point is to put one of every
// case a commander has to reason about on the screen at once: someone away on
// MC, someone on an MC they consume in camp, someone on light duty, someone
// whose excuse ends TODAY (the borderline returnee the parade state flags), a
// pending MO outcome, leave, a manual book-out, and a manual book-in that
// overrides an MC. Anything that only shows up on a specific day of the cycle
// is invisible in a demo unless it is placed there deliberately.
const MEDICAL = [
  // Away on MC — out of camp, off the parade state's in-camp strength.
  { d4: by(2),  status: "MC",         reason: "URTI",             from: -1, to: 2,  inCamp: "FALSE" },
  { d4: by(7),  status: "MC",         reason: "Gastroenteritis",  from: 0,  to: 1,  inCamp: "FALSE" },
  { d4: by(19), status: "Warded",     reason: "Dengue",           from: -3, to: 4,  inCamp: "FALSE" },
  // MC the recruit consumes IN camp: still counted in strength, still excused.
  { d4: by(11), status: "MC",         reason: "Sprained wrist",   from: -1, to: 1,  inCamp: "TRUE" },
  // In camp, restricted.
  { d4: by(4),  status: "LD",         reason: "Shin splints",     from: -2, to: 3,  inCamp: "TRUE" },
  { d4: by(23), status: "LD",         reason: "Lower back",       from: 0,  to: 5,  inCamp: "TRUE" },
  { d4: by(30), status: "Excuse RMJ", reason: "Knee pain",        from: -5, to: 6,  inCamp: "TRUE" },
  // Ends TODAY — the "borderline returnee" the parade state singles out.
  { d4: by(15), status: "Excuse RMJ", reason: "Ankle sprain",     from: -6, to: 0,  inCamp: "TRUE" },
  // Reported sick this morning, MO outcome not yet known.
  { d4: by(26), status: "Pending",    reason: "Fever",            from: 0,  to: 0,  inCamp: "TRUE" },
  // Already over — history, so the Medical tab is not just a snapshot of today.
  { d4: by(2),  status: "LD",         reason: "Blisters",         from: -21, to: -16, inCamp: "TRUE" },
  { d4: by(9),  status: "MC",         reason: "URTI",             from: -30, to: -27, inCamp: "FALSE" },
  { d4: by(34), status: "NIL",        reason: "Headache",         from: -12, to: -12, inCamp: "TRUE" },
];

const medical = MEDICAL.map((m, i) => ({
  id: medId(),
  d4: m.d4,
  date: day(m.from),
  reason: `${m.status} - ${m.reason}`,
  location: m.status === "Warded" ? "Changi General Hospital" : "Medical Centre",
  status: m.status,
  startDate: day(m.from),
  endDate: day(m.to),
  inCamp: m.inCamp,
}));

// Who is on a live status TODAY, by the same rule the app uses (medStatusActive,
// js/helpers.js:508): today within [start, end] inclusive, and NIL never counts.
// Derived from the same array the rows came from, so the two cannot drift.
const activeToday = new Map(
  MEDICAL.filter((m) => m.status !== "NIL" && m.from <= 0 && m.to >= 0)
    .map((m) => [m.d4, m.status]),
);

// Roster.status is the recruit's CURRENT medical status (0002_security.sql
// documents the live values: LD / MC / Active / Excuse RMJ / Pending / NIL).
// Keep it consistent with the Medical rows above, or the dashboard's "Active"
// count and the Medical tab disagree on screen.
for (const r of roster) if (activeToday.has(r.id)) r.status = activeToday.get(r.id);

const leave = [
  // Covering today — out of camp, same as an away MC.
  { d4: by(5),  type: "Annual Leave", from: -1, to: 1, reason: "Family" },
  { d4: by(21), type: "Off",          from: 0,  to: 0, reason: "Off in lieu" },
  // Upcoming — shows on the calendar without affecting today's strength.
  { d4: by(12), type: "Annual Leave", from: 3,  to: 7, reason: "Overseas" },
  { d4: by(28), type: "Off",          from: 2,  to: 2, reason: "Off in lieu" },
  // Taken.
  { d4: by(3),  type: "Annual Leave", from: -14, to: -12, reason: "Family" },
  { d4: by(17), type: "Off",          from: -9,  to: -9,  reason: "Off in lieu" },
].map((l, i) => ({
  id: leaveId(), d4: l.d4, type: l.type,
  startDate: day(l.from), endDate: day(l.to),
  days: String(l.to - l.from + 1), reason: l.reason,
}));

// Manual book-out: day-scoped by construction (isBookedOut, js/helpers.js:528),
// so `outSince` must be TODAY in ISO or the recruit reads as in camp.
for (const [n, reason] of [[8, "MO"], [33, "Outfield recce"]]) {
  const r = roster.find((x) => x.id === by(n));
  r.outOfCamp = "TRUE"; r.outReason = reason; r.outSince = iso(0); r.location = "Out";
}
// Manual book-in overriding an away MC — the commander counted them present.
{
  const r = roster.find((x) => x.id === by(7));
  r.campIn = "TRUE"; r.campInSince = iso(0);
}

const appointments = [
  { d4: by(1),  reason: "Dental",          from: 0, time: "0900", loc: "Dental Centre",  resolved: "FALSE", out: "TRUE" },
  { d4: by(14), reason: "Physio review",   from: 0, time: "1400", loc: "Physio",         resolved: "FALSE", out: "FALSE" },
  { d4: by(22), reason: "Specialist - knee", from: 1, time: "1030", loc: "CGH",          resolved: "FALSE", out: "TRUE" },
  { d4: by(6),  reason: "Eye test",        from: 4, time: "1100", loc: "Medical Centre", resolved: "FALSE", out: "FALSE" },
  { d4: by(29), reason: "Dental",          from: -7, time: "0930", loc: "Dental Centre", resolved: "TRUE",  out: "TRUE" },
].map((a, i) => ({
  id: apptId(), d4: a.d4, reason: a.reason, date: day(a.from),
  time: a.time, location: a.loc, resolved: a.resolved, outOfCamp: a.out,
}));

// ── Conducts and the records hanging off them ───────────────────────────────
// Spread back over five weeks so the progression and comparison views have a
// series to draw, with one conduct TODAY so the Attendance tab opens on
// something live.
const conducts = [
  { id: "c001", name: "Orientation Run",     at: -33 },
  { id: "c002", name: "Metabolic Circuit 1", at: -26 },
  { id: "c003", name: "Route March 4km",     at: -19 },
  { id: "c004", name: "IPPT 1",              at: -12 },
  { id: "c005", name: "Strength Training 1", at: -5 },
  { id: "c006", name: "2.4km Run",           at: 0 },
];

const attendance = [], polar = [];
conducts.forEach((c, i) => {
  // Everyone excused today is a fallout for today's conduct, which is what
  // makes the Attendance numbers add up against the parade state.
  const px = i === conducts.length - 1 ? activeToday.size : (i % 4) + 1;
  attendance.push({
    id: attId(), date: day(c.at), time: "0730", conductId: c.id,
    program: pick(PROGRAMS, i),
    total: String(recruits.length),
    participating: String(recruits.length - px),
    px: String(px), fallout: String(i % 3),
    lms: String(recruits.length - px - (i % 3)),
    remarks: i % 2 ? "" : "hot weather - extra water parade",
  });
});

// Per-person dropout rows for the three most recent conducts.
//
// `type` is the enum the app writes (js/forms.js:1176): PX = pre-existing
// status, Fallout = dropped out during the conduct, RSI = reported sick at
// first parade. `reason` is FREE TEXT, and the MSK analytics classifies it with
// keywords (isMSKReason, js/helpers.js:1016) to decide which dropouts were
// musculoskeletal. A bare status code like "MC" classifies as nothing, so the
// Daily MSK Impact chart would sit flat at zero — the reasons have to read the
// way a commander would actually write them.
const DROPOUTS = [
  { conduct: "c004", at: -12, rows: [
    { n: 4,  type: "PX",      reason: "LD - shin splints" },
    { n: 30, type: "PX",      reason: "Excuse RMJ - knee pain" },
    { n: 12, type: "Fallout", reason: "Ankle sprain during warm-up" },
    { n: 41, type: "RSI",     reason: "Fever" },
  ] },
  { conduct: "c005", at: -5, rows: [
    { n: 4,  type: "PX",      reason: "LD - shin splints" },
    { n: 23, type: "PX",      reason: "LD - lower back strain" },
    { n: 37, type: "Fallout", reason: "Hip flexor tightness" },
    { n: 26, type: "RSI",     reason: "Gastric" },
    { n: 11, type: "Fallout", reason: "Wrist pain on IMT" },
  ] },
  { conduct: "c006", at: 0, rows: [
    { n: 4,  type: "PX",      reason: "LD - shin splints" },
    { n: 23, type: "PX",      reason: "LD - lower back strain" },
    { n: 30, type: "PX",      reason: "Excuse RMJ - knee pain" },
    { n: 15, type: "PX",      reason: "Excuse RMJ - ankle sprain" },
    { n: 26, type: "RSI",     reason: "Fever - sent to MO" },
    { n: 8,  type: "Fallout", reason: "Achilles sore, stopped at 1.6km" },
  ] },
];

const conductDetail = DROPOUTS.flatMap(({ conduct, at, rows }) =>
  rows.map((r) => ({
    id: detailId(), date: day(at), time: "0730", d4: by(r.n),
    type: r.type, reason: r.reason, conductId: conduct, program: "Combined",
  })));

// Heart-rate telemetry for the two most recent conducts.
[["c005", -5], ["c006", 0]].forEach(([conductId, offset]) => {
  recruits.forEach((r, i) => {
    if (activeToday.has(r.id)) return;         // excused - no watch data
    polar.push({
      id: polarId(), d4: r.id, date: day(offset), conductId,
      avgHr: String(138 + ((i * 7) % 42)), maxHr: String(172 + ((i * 3) % 24)),
      minHr: String(68 + (i % 18)), calories: String(280 + ((i * 11) % 240)),
      trainingLoad: String(35 + ((i * 5) % 70)), duration: String(40 + (i % 20)),
      distance: String(2 + (i % 6)),
    });
  });
});

// IPPT: three attempts, spread out, improving — so the progression card and
// the first-vs-latest comparison have a real series to draw.
//
// Scores are spread deliberately across every award band (≥90 Gold★, ≥85 Gold,
// ≥75 Silver, ≥61 Pass, <61 Fail — js/ippt-scoring.js:144) and improve by
// attempt: the first attempt carries a handful of failures, the third a few
// Gold★. A demo where everyone maxes out shows none of the app's banding.
const ippt = [];
recruits.forEach((r, i) => {
  [[-68, 0], [-33, 1], [-12, 2]].forEach(([offset, n]) => {
    if (i % 9 === 0 && n === 2) return;        // a few have not taken the latest
    const score = Math.min(98, 48 + ((i * 7) % 36) + n * 5);
    // Stations are derived from the score rather than the other way round, so
    // the per-station trend lines move with it instead of contradicting it.
    const runSec = 810 - (score - 48) * 7 - n * 10;
    ippt.push({
      id: ipptId(), d4: r.id, attempt: String(n + 1),
      date: day(offset),
      pushups: String(20 + Math.round((score - 48) * 0.55) + n),
      situps: String(24 + Math.round((score - 48) * 0.5) + n),
      runTime: `${Math.floor(runSec / 60)}:${d2(runSec % 60)}`,
      score: String(score),
    });
  });
});

const rm = [];
[[-19, "1", 4], [-40, "2", 8]].forEach(([offset, rmNum, km]) => {
  recruits.forEach((r, i) => {
    if (i % 11 === 0) return;                  // excused on the day
    rm.push({
      id: rmId(), d4: r.id, rmNum, date: day(offset),
      time: `${km * 12 + (i % 14)}:${d2((i * 7) % 60)}`,
      avgHr: String(132 + (i % 30)), maxHr: String(168 + (i % 22)),
      pass: i % 13 === 0 ? "NO" : "YES",
    });
  });
});

const soc = recruits.filter((_, i) => i % 2 === 0).map((r, i) => ({
  id: socId(), d4: r.id, socNum: "1", date: day(-26),
  time: `${8 + (i % 4)}:${d2((i * 11) % 60)}`,
  avgHr: String(150 + (i % 25)), pass: i % 9 === 0 ? "NO" : "YES",
}));

// MSK: the one tab whose rows arrive by Google Form rather than the app.
//
// `type` is the FORM ENTRY TYPE, not the kind of injury: the analytics splits
// rows on it, counting only those whose type contains "report" as injuries and
// those containing "log"/"exercise" as physio follow-ups (js/render.js:241).
// A row typed "Sprain" is neither, and silently counts for nothing — which is
// why the injury kind belongs in the description instead.
const MSK_CASES = [
  { n: 4,  kind: "Overuse",   desc: "Shin splints after route march",   regions: "Lower Leg",  cleared: "FALSE", ago: 12 },
  { n: 15, kind: "Sprain",    desc: "Rolled ankle on the SOC low wall", regions: "Ankle",      cleared: "TRUE",  ago: 34 },
  { n: 23, kind: "Strain",    desc: "Lower back pain lifting stores",   regions: "Lower Back", cleared: "FALSE", ago: 6 },
  { n: 30, kind: "Overuse",   desc: "Anterior knee pain on stairs",     regions: "Knee",       cleared: "FALSE", ago: 19 },
  { n: 11, kind: "Sprain",    desc: "Wrist landing from IMT",           regions: "Wrist",      cleared: "FALSE", ago: 2 },
  { n: 8,  kind: "Overuse",   desc: "Achilles tightness",               regions: "Ankle",      cleared: "TRUE",  ago: 47 },
  { n: 19, kind: "Contusion", desc: "Bruised shoulder, stretcher PT",   regions: "Shoulder",   cleared: "TRUE",  ago: 25 },
  { n: 37, kind: "Overuse",   desc: "Hip flexor tightness after RM",    regions: "Hip",        cleared: "FALSE", ago: 9 },
  { n: 4,  kind: "Overuse",   desc: "Shin splints - still sore on runs", regions: "Lower Leg", cleared: "FALSE", ago: 3 },
  { n: 23, kind: "Strain",    desc: "Back pain eased, cleared for RM",  regions: "Lower Back", cleared: "FALSE", ago: 1 },
];

const msk = MSK_CASES.flatMap((m) => {
  const report = {
    timestamp: day(-m.ago), d4: by(m.n), type: "Injury Report",
    description: `${m.kind} - ${m.desc}`,
    physioDate: day(-m.ago + 2), exercises: "",
    cleared: m.cleared, manualRegions: m.regions,
  };
  // Roughly half get a physio follow-up, so the case cards have both halves.
  if (m.ago % 2 !== 0) return [report];
  return [report, {
    timestamp: day(-m.ago + 2), d4: by(m.n), type: "Exercise Log",
    description: `Physio review - ${m.kind.toLowerCase()}`,
    physioDate: day(-m.ago + 2),
    exercises: "Eccentric loading 3x15 daily, isometric holds 5x30s",
    cleared: m.cleared, manualRegions: m.regions,
  }];
});

// ── Load ────────────────────────────────────────────────────────────────────
// ── Duty schedule (0009) ────────────────────────────────────────────────────
//
// Three tables, three different kinds of fact, which is the whole point of the
// split: `duty` is an assignment (a person, a date, a role), `calendar` is a
// fact about a DATE that is true for everyone, and `oilRule` is an entitlement
// rule. Absence is NOT here - OFF/AL are Leave rows and MC is a Medical row,
// all read through outOfCampMap, so the grid cannot disagree with the strength
// board about who is in camp.
//
// Ids are DETERMINISTIC rather than nextId(): the natural key IS the id, so a
// reseed upserts the same rows and two devices writing the same slot converge
// instead of minting two rows for it.
const commanders = roster.filter((r) => r.role === "Commander");
const duty = [];
for (let i = 0; i < 10; i++) {
  const date = iso(i - 3);                            // a few days either side of today
  const wd = new Date(date + "T00:00:00Z").getUTCDay();
  if (wd === 0 || wd === 6) continue;                 // weekends carry no duty
  const slots = [["CDS", ""], ["COS", ""], ["PDS", "1"], ["PDS", "2"]];
  slots.forEach(([role, slot], n) => {
    const who = commanders[(i + n) % commanders.length];
    duty.push({
      id: `duty-${date}-${role}${slot}`, date, role, slot, d4: who.id,
      status: "published", source: "manual", note: "",
    });
  });
}

const calendar = [
  { id: `cal-${iso(2)}-IPPT`, date: iso(2), code: "IPPT", label: "IPPT", note: "" },
  { id: `cal-${iso(9)}-NDP`,  date: iso(9), code: "NDP",  label: "NDP rehearsal", note: "" },
];

// Applies To is ALL, an appointment class, or ONE commander's 4D - never a
// name. Days are fractional in the real data, so seed a 0.5 to keep that path
// exercised.
const oilRule = [
  { id: "oil-arr-ALL",   event: "ARR",       appliesTo: "ALL", days: "1",   notes: "Everyone" },
  { id: "oil-panzer-VC", event: "PANZER",    appliesTo: "VC",  days: "4",   notes: "Role entitlement" },
  { id: "oil-panzer-SC", event: "PANZER",    appliesTo: "SC",  days: "2",   notes: "Role entitlement" },
  { id: `oil-armskote-${commanders[0].id}`, event: "ARMSKOTE",
    appliesTo: commanders[0].id, days: "0.5", notes: "Individual" },
];

const TABS = [
  ["Conducts", conducts.map(({ id, name }) => ({ id, name }))],
  ["Roster", roster], ["IPPT", ippt], ["Medical", medical], ["Leave", leave],
  ["Appointments", appointments], ["PolarFlow", polar], ["Attendance", attendance],
  ["ConductDetail", conductDetail], ["RouteMarch", rm], ["SOC", soc],
  ["Duty", duty], ["Calendar", calendar], ["OilRules", oilRule],
];

try {
  const ping = await fetch(`${API}?action=ping`).then((r) => r.json());
  if (!ping.ok) throw new Error("API did not answer ping");

  for (const [tab, rows] of TABS) {
    if (!rows.length) continue;
    // The first chunk goes in as a full-tab `write`, which REPLACES the tab.
    // applyOps alone only upserts by id, so a reseed would layer this run's
    // rows on top of whatever an older seed left behind - and it did exactly
    // that the day these ids stopped being "md-01" and became numeric strings.
    // A seed has to be idempotent no matter what the previous one keyed on.
    await post({ action: "write", tab, data: rows.slice(0, 50) });
    // The rest via chunked applyOps, mirroring how the client batches
    // (BATCH_MAX = 50) - so the seed exercises the same write path the app uses.
    for (let i = 50; i < rows.length; i += 50) {
      const ops = rows.slice(i, i + 50).map((row) => ({ op: "upsert", row }));
      const res = await post({ action: "applyOps", tab, ops });
      if (res.failed) throw new Error(`${tab}: ${res.failed} ops failed`);
    }
    console.log(`  ${tab.padEnd(15)} ${String(rows.length).padStart(4)} rows`);
  }

  // MSK has no `id` column, so a full-tab replace is its only write path
  // (0001_init.sql) - applyOps upserts would be refused, by design.
  await post({ action: "write", tab: "MSK", data: msk });
  console.log(`  ${"MSK".padEnd(15)} ${String(msk.length).padStart(4)} rows`);

  const out = [...activeToday.keys()].length;
  console.log(`\nSeeded ${roster.length} people (${recruits.length} recruits, ${roster.length - recruits.length} commanders).`);
  console.log(`Today (${day(0)}): ${out} on a medical status, 2 booked out, 2 on leave.`);
  console.log("Reload the app to see it.");
} catch (e) {
  console.error("\nSeed failed:", e.message);
  console.error(`Is the dev environment up?  ./scripts/dev-env.sh up`);
  process.exitCode = 1;
}
