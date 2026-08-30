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

// ── Synthetic people ────────────────────────────────────────────────────────
const SURNAMES = ["TAN", "LIM", "LEE", "NG", "WONG", "CHAN", "KUMAR", "RAHMAN",
  "GOH", "TEO", "ONG", "SIM", "YEO", "CHUA", "KOH", "LOW", "ANG", "HO"];
const GIVEN = ["WEI MING", "JUN HAO", "ZHI HAO", "YI XUAN", "JIA JUN", "KAI XIN",
  "ARJUN", "FAIZAL", "RYAN", "MARCUS", "DARREN", "ELROY", "SHAWN", "BENJAMIN"];
const BLOOD = ["O+", "A+", "B+", "AB+", "O-"];
const STATUS = ["Active", "LD", "MC", "NIL", "Excuse RMJ", "Pending"];
const PROGRAMS = ["PTP", "BMT", "Combined"];

const pick = (a, i) => a[i % a.length];
const d2 = (n) => String(n).padStart(2, "0");

// 3 platoons x 3 sections x ~5 = ~45 recruits, plus 6 commanders. The live
// sheet's ratio is 256 recruits : 26 commanders; this keeps the shape.
const roster = [];
for (let plt = 1; plt <= 3; plt++) {
  for (let n = 1; n <= 15; n++) {
    const i = roster.length;
    const d4 = `${plt}${d2(n)}`.padStart(4, "0");
    roster.push({
      id: d4, "4d": `C${d4}`,
      name: `${pick(GIVEN, i)} ${pick(SURNAMES, i)}`,
      age: String(18 + (i % 5)),
      status: pick(STATUS, i),
      role: "Recruit",
      rank: "REC",
      program: pick(PROGRAMS, i),
      height: String(165 + (i % 20)),
      weight: String(55 + (i % 25)),
      dob: `${d2(1 + (i % 28))} ${pick(["Jan","Mar","Jun","Sep","Nov"], i)} 200${5 + (i % 3)}`,
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
      campIn: "TRUE",
      groups: i % 9 === 0 ? "Guard" : "",
      location: "Camp",
      ration: i % 5 === 0 ? "Halal" : "Normal",
    });
  }
}
for (let c = 1; c <= 6; c++) {
  roster.push({
    id: d2(c).padStart(4, "0"), "4d": d2(c).padStart(4, "0"),
    name: `CPT ${pick(SURNAMES, c + 5)}`, role: "Commander", rank: "CPT",
    status: "Active", outOfCamp: "FALSE", campIn: "TRUE", program: "Combined",
    phone: `9${String(5000000 + c * 131).slice(0, 7)}`,
  });
}

const conducts = [
  { id: "c001", name: "Orientation Run" }, { id: "c002", name: "Metabolic Circuit 1" },
  { id: "c003", name: "2.4km Run" }, { id: "c004", name: "Strength Training 1" },
  { id: "c005", name: "Route March 4km" }, { id: "c006", name: "IPPT 1" },
];

const recruits = roster.filter((r) => r.role === "Recruit");
const ippt = [], medical = [], leave = [], polar = [], attendance = [], conductDetail = [];

recruits.forEach((r, i) => {
  for (let att = 1; att <= 1 + (i % 3); att++) {
    const push = 20 + ((i * 3 + att * 5) % 40);
    const sit = 25 + ((i * 7 + att * 3) % 35);
    ippt.push({
      id: `ip-${r.id}-${att}`, d4: r.id, attempt: String(att),
      date: `${d2(5 + att * 3)} ${pick(["Apr", "May", "Jun"], att)} 2026`,
      pushups: String(push), situps: String(sit),
      runTime: `${11 + (i % 4)}:${d2((i * 13) % 60)}`,
      score: String(50 + ((push + sit) % 40)),
    });
  }
  if (i % 6 === 0) {
    medical.push({
      id: `md-${r.id}`, d4: r.id, date: `${d2(1 + (i % 27))} Jul 2026`,
      reason: pick(["MC - URTI", "LD - ankle", "Excuse RMJ"], i),
      location: "Medical Centre", status: pick(["MC", "LD", "Excuse RMJ"], i),
      startDate: `${d2(1 + (i % 27))} Jul 2026`, endDate: `${d2(3 + (i % 25))} Jul 2026`,
      inCamp: "TRUE",
    });
  }
  if (i % 8 === 0) {
    leave.push({
      id: `lv-${r.id}`, d4: r.id, type: "Annual Leave",
      startDate: `${d2(10 + (i % 15))} Aug 2026`, endDate: `${d2(12 + (i % 15))} Aug 2026`,
      days: "3", reason: "Family",
    });
  }
  polar.push({
    id: `pf-${r.id}`, d4: r.id, date: "22 Jul 2026", conductId: "c002",
    avgHr: String(140 + (i % 40)), maxHr: String(175 + (i % 20)), minHr: String(70 + (i % 15)),
    calories: String(300 + (i % 200)), trainingLoad: String(40 + (i % 60)),
    duration: "45", distance: String((i % 6) + 2),
  });
});

conducts.forEach((c, i) => {
  attendance.push({
    id: `at-${c.id}`, date: `${d2(4 + i * 4)} Jul 2026`, time: "0730",
    conductId: c.id, program: pick(PROGRAMS, i),
    total: String(recruits.length), participating: String(recruits.length - (i % 5)),
    px: String(i % 5), fallout: String(i % 3), lms: String(recruits.length - (i % 7)),
    remarks: i % 2 ? "" : "hot weather",
  });
  if (i % 2 === 0) {
    const r = recruits[i * 3];
    if (r) conductDetail.push({
      id: `cd-${c.id}-${r.id}`, date: `${d2(4 + i * 4)} Jul 2026`, time: "0730",
      d4: r.id, type: "PX", reason: "MC", conductId: c.id, program: "Combined",
    });
  }
});

// ── Load ────────────────────────────────────────────────────────────────────
const TABS = [
  ["Conducts", conducts], ["Roster", roster], ["IPPT", ippt],
  ["Medical", medical], ["Leave", leave], ["PolarFlow", polar],
  ["Attendance", attendance], ["ConductDetail", conductDetail],
];

try {
  const ping = await fetch(`${API}?action=ping`).then((r) => r.json());
  if (!ping.ok) throw new Error("API did not answer ping");

  for (const [tab, rows] of TABS) {
    if (!rows.length) continue;
    // Chunked applyOps, mirroring how the client batches (BATCH_MAX = 50).
    for (let i = 0; i < rows.length; i += 50) {
      const ops = rows.slice(i, i + 50).map((row) => ({ op: "upsert", row }));
      const res = await post({ action: "applyOps", tab, ops });
      if (res.failed) throw new Error(`${tab}: ${res.failed} ops failed`);
    }
    console.log(`  ${tab.padEnd(15)} ${String(rows.length).padStart(4)} rows`);
  }
  console.log(`\nSeeded ${roster.length} people (${recruits.length} recruits, ${roster.length - recruits.length} commanders).`);
  console.log("Reload the app to see it.");
} catch (e) {
  console.error("\nSeed failed:", e.message);
  console.error(`Is the dev environment up?  ./scripts/dev-env.sh up`);
  process.exitCode = 1;
}
