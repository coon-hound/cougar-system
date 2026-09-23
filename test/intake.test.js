// Tests for the intake changeover planner (scripts/intake-plan.mjs).
//
// The planner makes one decision, ~300 times, and both ways of getting it wrong
// are silent:
//
//   * a returnee not recognised loses his medical and injury history;
//   * two people merged gives one recruit the other's medical history, which
//     nothing downstream will ever flag.
//
// So the cases below are weighted towards the matcher — what it must catch,
// what it must refuse to guess at, and what it must never carry across a
// changeover no matter who the person is.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const PLAN = pathToFileURL(path.join(ROOT, "scripts/intake-plan.mjs")).href;

let P;
const load = async () => (P ??= await import(PLAN));

// Deterministic stand-in for the keyed digest. The planner only requires that
// the same input gives the same hex string.
function fakeHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(4);
}

// A roll row with sensible defaults, so each test states only what it is about.
const rollRow = (o) => ({ "4D": "", Name: "", ...o });

function run(P, { roll, roster = [], people = [], data = {}, overrides = {}, cutoff = "2026-02-16" }) {
  return P.planIntake({
    label: "26/02", prevLabel: "25/08", cutoff,
    hash: fakeHash, roll, roster, people, data, overrides,
  });
}

module.exports = async function () {
  const P = await load();

  // ── Name keys ───────────────────────────────────────────────────────────
  suite("intake — name normalisation");

  await test("token order does not matter (Chinese names arrive either way)", () => {
    eq(P.nameKey("TAN WEI MING"), P.nameKey("WEI MING TAN"));
  });

  await test("particles are ignored (BIN / B. / S/O)", () => {
    eq(P.nameKey("MUHAMMAD BIN ALI"), P.nameKey("MUHAMMAD B. ALI"));
    eq(P.nameKey("RAJU S/O KUMAR"), P.nameKey("RAJU KUMAR"));
  });

  await test("different people do not collide", () => {
    ok(P.nameKey("TAN WEI MING") !== P.nameKey("TAN WEI LONG"));
  });

  await test("similarity is measured against the shorter name", () => {
    // A roll that adds a given name is the common case, not a different person.
    eq(P.nameSimilarity("TAN WEI MING", "TAN WEI MING RYAN"), 1);
    ok(P.nameSimilarity("TAN WEI MING", "LIM ZHI HAO") === 0);
  });

  await test("padD4 leaves an archive key alone", () => {
    eq(P.padD4("C1101"), "1101");
    eq(P.padD4("1"), "0001");
    eq(P.padD4("1101@25-08"), "1101@25-08");
  });

  await test("archiveKey never double-stamps", () => {
    eq(P.archiveKey("1101", "25/08"), "1101@25-08");
    eq(P.archiveKey("1101@25-08", "26/02"), "1101@25-08");
    eq(P.archiveKey("", "25/08"), "");
  });

  // ── CSV ─────────────────────────────────────────────────────────────────
  suite("intake — reading the roll");

  await test("quoted fields, embedded commas, doubled quotes, CRLF", () => {
    const rows = P.parseCsv('4D,Name\r\n1101,"TAN, WEI MING"\r\n1102,"O""BRIEN JOHN"\r\n');
    eq(rows.length, 2);
    eq(rows[0].Name, "TAN, WEI MING");
    eq(rows[1].Name, 'O"BRIEN JOHN');
  });

  await test("a final row with no trailing newline is not dropped", () => {
    const rows = P.parseCsv("4D,Name\n1101,ALPHA\n1102,BRAVO");
    eq(rows.length, 2);
    eq(rows[1]["4D"], "1102");
  });

  await test("header aliases are accepted and unknown columns reported", () => {
    const plan = run(P, {
      roll: [{ "4D No": "1101", "Full Name": "ALPHA ONE", "Vocation Code": "X99" }],
    });
    eq(plan.stats.recruits, 1);
    eq(plan.newRoster[0].row.name, "ALPHA ONE");
    ok(plan.issues.some((i) => i.level === "warn" && /Vocation Code/.test(i.msg)));
  });

  // ── Validation ──────────────────────────────────────────────────────────
  suite("intake — the roll must be usable");

  await test("a duplicated 4D blocks", () => {
    const plan = run(P, {
      roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE" }), rollRow({ "4D": "1101", Name: "BRAVO TWO" })],
    });
    ok(!plan.ok);
    ok(plan.issues.some((i) => /already used on row/.test(i.msg)));
  });

  await test("a commander-range 4D blocks", () => {
    const plan = run(P, { roll: [rollRow({ "4D": "0012", Name: "ALPHA ONE" })] });
    ok(!plan.ok);
    ok(plan.issues.some((i) => /commander range/.test(i.msg)));
  });

  await test("a row with no name blocks", () => {
    const plan = run(P, { roll: [rollRow({ "4D": "1101", Name: "" })] });
    ok(!plan.ok);
  });

  await test("a blank spacer row is skipped, not an error", () => {
    const plan = run(P, {
      roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE" }), rollRow({ "4D": "", Name: "" })],
    });
    ok(plan.ok);
    eq(plan.stats.rollRows, 1);
  });

  // ── Matching ────────────────────────────────────────────────────────────
  suite("intake — recognising who came back");

  const outgoing = [
    { id: "1101", name: "TAN WEI MING", role: "Recruit", pid: null },
    { id: "1203", name: "LIM ZHI HAO", role: "Recruit", pid: null },
    { id: "0001", name: "COMD TAN", role: "Commander", pid: null },
  ];

  await test("an all-new roll produces no returnees", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "1101", Name: "NEW PERSON ONE" })],
    });
    ok(plan.ok);
    eq(plan.stats.returnees, 0);
    eq(plan.matches[0].tier, P.TIER.NEW);
  });

  await test("a returnee is matched by name and re-homed onto the new seat", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: {
        medical: [{ id: "m1", d4: "1101", status: "LD", startDate: "01 Mar 2025", endDate: "05 Mar 2025" }],
        ippt: [{ id: "p1", d4: "1101", attempt: "1", date: "10 Mar 2025", score: "70" }],
      },
    });
    ok(plan.ok);
    eq(plan.stats.returnees, 1);
    eq(plan.returnees[0].oldD4, "1101");
    eq(plan.returnees[0].newD4, "2205");
    eq(plan.returnees[0].tier, P.TIER.NAME);
    eq(plan.carried.medical.length, 1);
    eq(plan.carried.medical[0].d4, "2205");
    eq(plan.carried.ippt[0].d4, "2205");
  });

  await test("a carried row gets a fresh id so the original can archive under its own", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: { medical: [{ id: "m1", d4: "1101", status: "LD", startDate: "01 Mar 2025", endDate: "05 Mar 2025" }] },
    });
    ok(plan.carried.medical[0].id !== "m1");
    ok(/^i-/.test(plan.carried.medical[0].id), "carried ids are i-prefixed");
  });

  await test("carried ids are deterministic across runs", () => {
    const mk = () => run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: { medical: [{ id: "m1", d4: "1101", status: "LD", startDate: "01 Mar 2025", endDate: "05 Mar 2025" }] },
    });
    eq(mk().carried.medical[0].id, mk().carried.medical[0].id);
  });

  await test("an exact pid match wins and needs no name agreement", () => {
    const plan = run(P, {
      people: [{ pid: "PABC", name: "TAN WEI MING", name_key: P.nameKey("TAN WEI MING"), last_d4: "1101", d4_history: ["1101"] }],
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING RYAN", PID: "PABC" })],
    });
    ok(plan.ok);
    eq(plan.matches[0].tier, P.TIER.PID);
    eq(plan.returnees[0].oldD4, "1101");
  });

  await test("two known people with the same name block rather than guess", () => {
    const plan = run(P, {
      people: [
        { pid: "PA", name: "TAN WEI MING", name_key: P.nameKey("TAN WEI MING"), last_d4: "1101", d4_history: ["1101"] },
        { pid: "PB", name: "TAN WEI MING", name_key: P.nameKey("TAN WEI MING"), last_d4: "1303", d4_history: ["1303"] },
      ],
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
    });
    ok(!plan.ok);
    eq(plan.matches[0].tier, P.TIER.AMBIGUOUS);
    ok(plan.issues.some((i) => /matches 2 known people/.test(i.msg)));
  });

  await test("an ambiguity is resolved by an override, not by order", () => {
    const plan = run(P, {
      people: [
        { pid: "PA", name: "TAN WEI MING", name_key: P.nameKey("TAN WEI MING"), last_d4: "1101", d4_history: ["1101"] },
        { pid: "PB", name: "TAN WEI MING", name_key: P.nameKey("TAN WEI MING"), last_d4: "1303", d4_history: ["1303"] },
      ],
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      overrides: { 2205: "PB" },
    });
    ok(plan.ok);
    eq(plan.matches[0].tier, P.TIER.OVERRIDE);
    eq(plan.returnees[0].oldD4, "1303");
  });

  await test("two roll rows matching one person demote BOTH", () => {
    // Resolving by arrival order would hand one of them the other's history.
    const plan = run(P, {
      roster: outgoing,
      roll: [
        rollRow({ "4D": "2205", Name: "TAN WEI MING" }),
        rollRow({ "4D": "2206", Name: "TAN WEI MING" }),
      ],
    });
    ok(!plan.ok);
    eq(plan.matches[0].tier, P.TIER.AMBIGUOUS);
    eq(plan.matches[1].tier, P.TIER.AMBIGUOUS);
    eq(plan.stats.returnees, 0);
  });

  await test("an override of NEW forces a fresh identity", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      overrides: { 2205: "NEW" },
    });
    ok(plan.ok);
    eq(plan.matches[0].tier, P.TIER.NEW);
    eq(plan.stats.returnees, 0);
  });

  await test("a near-miss name BLOCKS and asks for an explicit decision", () => {
    const plan = run(P, {
      roster: [{ id: "1101", name: "TAN WEI MING", role: "Recruit" }],
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING RYAN" })],
    });
    ok(!plan.ok, "a guess about whose medical history this is must not proceed silently");
    eq(plan.matches[0].tier, P.TIER.FUZZY);
    ok(plan.issues.some((i) => i.level === "error" && /--override 2205=/.test(i.msg)));
  });

  await test("--accept-fuzzy downgrades it to a warning", () => {
    const plan = P.planIntake({
      label: "26/02", prevLabel: "25/08", cutoff: "2026-02-16", hash: fakeHash,
      roster: [{ id: "1101", name: "TAN WEI MING", role: "Recruit" }],
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING RYAN" })],
      people: [], data: {}, overrides: {}, acceptFuzzy: true,
    });
    ok(plan.ok);
    eq(plan.stats.returnees, 1);
    ok(plan.issues.some((i) => i.level === "warn" && /--accept-fuzzy/.test(i.msg)));
  });

  await test("two common tokens in common is NOT a match", () => {
    // The case a rehearsal against seeded data turned up: "JOSHUA LIM KAI EN"
    // scored 0.67 against "KAI XIN LIM" on {lim, kai} alone. Singaporean names
    // draw on a small pool of tokens, so two shared ones mean very little.
    const plan = run(P, {
      roster: [{ id: "1101", name: "KAI XIN LIM", role: "Recruit" }],
      roll: [rollRow({ "4D": "2205", Name: "JOSHUA LIM KAI EN" })],
    });
    ok(plan.ok);
    eq(plan.matches[0].tier, P.TIER.NEW);
    eq(plan.stats.returnees, 0);
  });

  await test("one shared token is not enough to be a match", () => {
    const plan = run(P, {
      roster: [{ id: "1101", name: "TAN WEI MING", role: "Recruit" }],
      roll: [rollRow({ "4D": "2205", Name: "TAN JUN JIE" })],
    });
    ok(plan.ok);
    eq(plan.matches[0].tier, P.TIER.NEW);
  });

  // ── What crosses the changeover ─────────────────────────────────────────
  suite("intake — what carries and what archives");

  const carryData = {
    medical: [{ id: "m1", d4: "1101", status: "LD", startDate: "01 Mar 2025", endDate: "05 Mar 2025" }],
    msk: [{ timestamp: "01 Mar 2025", d4: "1101", description: "ankle" }],
    ippt: [{ id: "p1", d4: "1101", date: "10 Mar 2025", score: "70" }],
    rm: [{ id: "r1", d4: "1101", date: "10 Mar 2025" }],
    soc: [{ id: "s1", d4: "1101", date: "10 Mar 2025" }],
    appointments: [
      { id: "a1", d4: "1101", date: "01 Mar 2025", reason: "past" },
      { id: "a2", d4: "1101", date: "01 Mar 2026", reason: "future" },
    ],
    leave: [
      { id: "l1", d4: "1101", type: "Annual Leave", startDate: "01 Mar 2025" },
      { id: "l2", d4: "0001", type: "Off-in-Lieu", startDate: "01 Mar 2025" },
    ],
  };

  await test("clinical and fitness history follows the person", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: carryData,
    });
    eq(plan.carried.medical.length, 1);
    eq(plan.carried.msk.length, 1);
    eq(plan.carried.ippt.length, 1);
    eq(plan.carried.rm.length, 1);
    eq(plan.carried.soc.length, 1);
    eq(plan.carried.msk[0].d4, "2205");
  });

  await test("MSK copies carry no id — that table has none", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: carryData,
    });
    eq(plan.carried.msk[0].id, undefined);
  });

  await test("only future appointments carry", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: carryData,
    });
    eq(plan.carried.appointments.length, 1);
    eq(plan.carried.appointments[0].reason, "future");
  });

  await test("commander leave survives; recruit leave does not", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: carryData,
    });
    eq(plan.carried.leave.length, 1);
    eq(plan.carried.leave[0].id, "l2");
  });

  await test("cohort-scoped tables are archived even for a returnee", () => {
    // Attendance / ConductDetail / PolarFlow describe conducts the new cohort
    // did not attend. Carrying them would corrupt strength and LMS counts.
    //
    // Conducts joined them in 0010. It was "keep" until intake 16 showed that
    // conduct names are retyped rather than reused, so a registry that never
    // archives only grows - 112 rows in one flat <select> on a phone. If this
    // assertion is ever "fixed" by dropping Conducts back out, the next
    // changeover silently inherits the previous cohort's whole picker.
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: carryData,
    });
    eq(plan.archived.sort(), ["Attendance", "ConductDetail", "Conducts", "PolarFlow"]);
    eq(plan.carried.attendance, undefined);
    eq(plan.carried.polar, undefined);
    eq(plan.carried.conducts, undefined);
  });

  await test("a non-returnee's records are not carried", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "SOMEBODY ELSE" })],
      data: carryData,
    });
    eq(plan.carried.medical.length, 0);
    eq(plan.carried.ippt.length, 0);
  });

  await test("an open medical status is closed at the cutoff and reported", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: { medical: [{ id: "m1", d4: "1101", status: "MC", startDate: "01 Mar 2025", endDate: "" }] },
    });
    eq(plan.clamped.length, 1);
    eq(plan.carried.medical[0].endDate, "15 Feb 2026");   // the day before the cutoff
  });

  await test("a status that already ended before the cutoff is left alone", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: { medical: [{ id: "m1", d4: "1101", status: "LD", startDate: "01 Mar 2025", endDate: "05 Mar 2025" }] },
    });
    eq(plan.clamped.length, 0);
    eq(plan.carried.medical[0].endDate, "05 Mar 2025");
  });

  // ── Registry ────────────────────────────────────────────────────────────
  suite("intake — the people registry");

  await test("every recruit on the new roll gets a pid", () => {
    const plan = run(P, {
      roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE" }), rollRow({ "4D": "1102", Name: "BRAVO TWO" })],
    });
    eq(plan.people.length, 2);
    ok(plan.people.every((p) => /^P[0-9A-F]+/.test(p.pid)));
    ok(plan.people[0].pid !== plan.people[1].pid);
  });

  await test("a returnee keeps one pid and accumulates seats", () => {
    const plan = run(P, {
      people: [{ pid: "PABC", name: "TAN WEI MING", name_key: P.nameKey("TAN WEI MING"), last_d4: "1101", d4_history: ["1101"], first_intake: "25/02" }],
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
    });
    eq(plan.people.length, 1);
    eq(plan.people[0].pid, "PABC");
    eq(plan.people[0].d4_history, ["1101", "2205"]);
    eq(plan.people[0].first_intake, "25/02");
    eq(plan.people[0].last_intake, "26/02");
  });

  await test("an NRIC in the roll matches across a name change", () => {
    const nricHash = fakeHash("nric:S9912123A");
    const plan = run(P, {
      people: [{ pid: "PABC", name: "OLD RECORDED NAME", name_key: P.nameKey("OLD RECORDED NAME"), nric_hash: nricHash, last_d4: "1101", d4_history: ["1101"] }],
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING", NRIC: "S9912123A" })],
    });
    ok(plan.ok);
    eq(plan.matches[0].tier, P.TIER.NRIC);
    eq(plan.returnees[0].oldD4, "1101");
  });

  await test("two people sharing an NRIC suffix are NOT the same person", () => {
    // The real collision that aborted the first changeover. Keying on the last
    // four would give these one digest, and the unique index on
    // people.nric_hash would reject the run - or worse, on a later intake,
    // match a stranger onto someone else's medical history.
    ok(P.nricKey("T0627509A") !== P.nricKey("T0410509A"));
    ok(P.nricKey("T0808034D") !== P.nricKey("T0473034D"));
  });

  await test("a bare NRIC suffix does not key at all", () => {
    // An identifier that is not unique must not drive an exact match; a roll
    // carrying only suffixes falls back to name matching.
    eq(P.nricKey("123A"), "");
    eq(P.nricKey(""), "");
    eq(P.nricKey("S9912123A"), "S9912123A");
    eq(P.nricKey("s99-121 23a"), "S9912123A");
  });

  await test("the raw NRIC never leaves the planner", () => {
    const plan = run(P, { roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE", NRIC: "S9912123A" })] });
    const dump = JSON.stringify(plan);
    ok(!dump.includes("S9912123A"), "raw NRIC must not appear anywhere in the plan");
    ok(!dump.includes("123A"), "not even the suffix");
  });

  await test("roster rows carry the pid and the intake stamp", () => {
    const plan = run(P, { roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE" })] });
    eq(plan.newRoster[0].intake, "26/02");
    ok(plan.newRoster[0].pid);
    eq(plan.newRoster[0].row["4d"], "C1101");
    eq(plan.newRoster[0].row.role, "Recruit");
  });

  await test("personal columns from the roll land on the roster row", () => {
    const plan = run(P, {
      roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE", "Date of Birth": "01 Jan 2007", "NOK Phone": "91234567", "Blood Type": "O+" })],
    });
    const r = plan.newRoster[0].row;
    eq(r.dob, "01 Jan 2007");
    eq(r.nokPhone, "91234567");
    eq(r.bloodType, "O+");
  });

  await test("every roster row has an identical key set (the full schema)", () => {
    const plan = run(P, {
      roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE", Phone: "91234567" }), rollRow({ "4D": "1102", Name: "BRAVO TWO" })],
    });
    eq(Object.keys(plan.newRoster[0].row).sort(), Object.keys(plan.newRoster[1].row).sort());
  });

  // ── Report ──────────────────────────────────────────────────────────────
  suite("intake — the report");

  await test("a blocked plan says so and names the problem", () => {
    const plan = run(P, {
      roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE" }), rollRow({ "4D": "1101", Name: "BRAVO TWO" })],
    });
    const text = P.formatReport(plan);
    ok(/NOT READY/.test(text));
    ok(/already used on row/.test(text));
  });

  await test("a clean plan invites the apply step", () => {
    const plan = run(P, { roll: [rollRow({ "4D": "1101", Name: "ALPHA ONE" })] });
    const text = P.formatReport(plan);
    ok(/READY/.test(text));
    ok(/--apply/.test(text));
  });

  await test("returnees are named in the report so a human can check them", () => {
    const plan = run(P, {
      roster: outgoing,
      roll: [rollRow({ "4D": "2205", Name: "TAN WEI MING" })],
      data: carryData,
    });
    const text = P.formatReport(plan);
    ok(/1101 -> 2205/.test(text));
    ok(/TAN WEI MING/.test(text));
  });
};
