// ── Synthetic company ────────────────────────────────────────────────────────
// Deliberately synthetic, following scripts/dev-seed.mjs: the shapes, volumes
// and ratios mirror the live sheet so the UI behaves realistically; the people
// do not exist. Every date is relative to today, because almost every screen
// here is date-windowed.
//
// This file is the shared seed for the three UI concepts. Each concept inlines
// a copy so it can be published as a single self-contained page.
const GIVEN = ["WEI MING","JUN HAO","ZHI HAO","YI XUAN","JIA JUN","KAI XIN","ARJUN",
  "FAIZAL","RYAN","MARCUS","DARREN","ELROY","SHAWN","BENJAMIN"];
const SUR = ["TAN","LIM","LEE","NG","WONG","CHAN","KUMAR","RAHMAN","GOH","TEO",
  "ONG","SIM","YEO","CHUA","KOH","LOW","ANG","HO"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const d2 = n => String(n).padStart(2, "0");
const at = o => { const d = new Date(); d.setDate(d.getDate() + o); return d; };
const day = (o = 0) => { const d = at(o); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const frac = (i, s) => { const v = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return v - Math.floor(v); };
const pick = (a, i) => a[i % a.length];

// 3 platoons x 15 recruits + 6 commanders. 4D reads C<plt>1<nn>, as in sample_polar.csv.
const PEOPLE = [];
for (let plt = 1; plt <= 3; plt++) {
  for (let n = 1; n <= 15; n++) {
    const i = PEOPLE.length;
    const ht = 165 + (i % 20), wt = 55 + (i % 25);
    PEOPLE.push({
      id: `C${plt}1${d2(n)}`, name: `${pick(GIVEN, i)} ${pick(SUR, i)}`,
      plt, sect: Math.ceil(n / 5), role: "Recruit", rank: "REC",
      age: 18 + (i % 5), ht, wt, bmi: +(wt / ((ht / 100) ** 2)).toFixed(1),
      prog: pick(["PTP", "BMT", "Combined"], i),
      rsi: Math.floor(frac(i, 3) * 5), state: "in", status: "", detail: "", until: null,
      ippt: 61 + Math.floor(frac(i, 9) * 34),
      hr: Array.from({ length: 6 }, (_, k) => 132 + Math.round(frac(i, k + 1) * 46)),
      load: Array.from({ length: 6 }, (_, k) => 40 + Math.round(frac(i, k + 5) * 55)),
    });
  }
}
for (let c = 1; c <= 6; c++) PEOPLE.push({
  id: d2(c).padStart(4, "0"), name: `${pick(GIVEN, c + 2)} ${pick(SUR, c + 5)}`,
  plt: Math.ceil(c / 2), sect: 0, role: "Commander", rank: pick(["CPT","LTA","3SG","2SG"], c),
  state: "in", status: "", detail: "", rsi: 0, bmi: 23.4, ippt: 78, hr: [], load: [],
});

// Today's picture: hand-written so one of every case a commander has to reason
// about is on screen at once, not generated noise.
const CASES = [
  [3,  "out", "MC",                "Fever · MO Camp",           2],
  [24, "in",  "MC+1",              "Trailing tag, auto",        0],
  [7,  "in",  "LD",                "Light Duty · ankle",        3],
  [12, "in",  "Excuse Heavy Load", "Lower back",                9],
  [16, "in",  "RMJ",               "Excuse Run March Jump",     2],
  [21, "out", "Warded",            "SGH Ward 44",            null],
  [28, "out", "Leave",             "Off-in-Lieu",               1],
  [31, "out", "Course",            "SISPEC brief",              1],
  [33, "out", "MA",                "1400h NUH · out of camp",   0],
  [38, "in",  "Guard Duty",        "Camp guard, 2nd relief",    0],
  [41, "in",  "MSK",               "R knee · physio wk 3",     14],
  [9,  "in",  "MSK",               "L ankle · cleared soon",    5],
  [22, "in",  "MSK",               "Lower back · 3rd episode", 21],
];
CASES.forEach(([i, state, status, detail, until]) => {
  Object.assign(PEOPLE[i], { state, status, detail, until });
});

const CONDUCTS = [
  { id: "c001", name: "Orientation Run",     at: -33, part: 43, str: 45, lms: 0,  fall: 1 },
  { id: "c002", name: "Metabolic Circuit 1", at: -26, part: 41, str: 45, lms: 38, fall: 2 },
  { id: "c003", name: "Route March 4km",     at: -19, part: 40, str: 45, lms: 40, fall: 3 },
  { id: "c004", name: "IPPT 1",              at: -12, part: 42, str: 45, lms: 0,  fall: 0 },
  { id: "c005", name: "Strength Training 1", at:  -5, part: 39, str: 45, lms: 35, fall: 2 },
  { id: "c006", name: "2.4km Run",           at:   0, part: 38, str: 45, lms: 36, fall: 2 },
];
