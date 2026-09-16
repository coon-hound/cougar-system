// Unit tests for the ONE rank-ordering source of truth in js/helpers.js:
// RANK_TIERS -> rankIndex / byRank / sortByRank, and the rankCategory buckets
// that are now derived from the same list.
//
// The thing these tests defend: rank is free text off a roster column, so the
// ordering has to be total and total-safe. A blank, a lowercase string, a
// "3sg." with punctuation and an outright unknown token must all sort
// somewhere predictable instead of throwing or shuffling the list.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");

// helpers.js is self-contained; it only needs a STATE object to exist.
// Top-level `const` does not become a property of a vm context the way a
// function declaration does (and, unlike browser <script> tags, it does not
// cross a second runInContext call either), so the rank tables are re-exported
// by an epilogue concatenated onto the SAME script - the same trick
// test/harness.js uses for STATE/API.
const EXPORTS = ["RANK_TIERS", "RANK_ORDER", "RANK_OFFICER", "RANK_WOSPEC", "RANK_ENLISTEE", "RANK_UNKNOWN"];
function loadHelpers() {
  const sandbox = {
    STATE: { roster: [], medical: [], leave: [] },
    console, Math, Date, JSON, String, Number, Array, Object,
    Boolean, RegExp, Set, Map, isNaN, parseInt, parseFloat,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, "js/helpers.js"), "utf8")
    + "\n;" + EXPORTS.map(n => `globalThis.${n} = ${n};`).join("");
  vm.runInContext(src, sandbox, { filename: "helpers.js" });
  return sandbox;
}

const H = loadHelpers();
// Rank ordering is a COMMAND BODY rule, so the default fixture is a commander.
const p = (rank, id, name) => ({ id: id || "", rank, name: name || "", role: "Commander" });
// An enlistee: the rank is carried, but it must never affect his position.
const e = (id, rank, name) => ({ id, rank: rank || "PTE", name: name || "", role: "Recruit" });
const ranksOf = list => list.map(r => r.rank);

module.exports = async function run() {
  suite("helpers: rank ordering (RANK_TIERS / rankIndex / sortByRank)");

  await test("one ordered source of truth, no duplicate tokens", () => {
    const seen = new Set();
    for (const t of H.RANK_ORDER) {
      ok(!seen.has(t), "token appears once: " + t);
      seen.add(t);
    }
    eq(H.RANK_ORDER.length, H.RANK_OFFICER.length + H.RANK_WOSPEC.length + H.RANK_ENLISTEE.length,
      "every token lands in exactly one tier");
  });

  await test("the category arrays are DERIVED, and stay in tier order", () => {
    // The parade state's three strength lines must still be able to bucket
    // every token - that is what these arrays are for - but they are no longer
    // a second copy of the vocabulary.
    eq(H.RANK_OFFICER[0], "BG", "officers start at the top");
    eq(H.RANK_ENLISTEE[H.RANK_ENLISTEE.length - 1], "REC", "REC is the bottom of the list");
    for (const arr of [H.RANK_OFFICER, H.RANK_WOSPEC, H.RANK_ENLISTEE]) {
      for (let i = 1; i < arr.length; i++) {
        ok(H.rankIndex(arr[i - 1]) < H.rankIndex(arr[i]),
          arr[i - 1] + " outranks " + arr[i]);
      }
    }
  });

  await test("officers outrank WOSPEC outrank enlistees", () => {
    const lowestOfficer = H.rankIndex(H.RANK_OFFICER[H.RANK_OFFICER.length - 1]);
    const highestWospec = H.rankIndex(H.RANK_WOSPEC[0]);
    const lowestWospec = H.rankIndex(H.RANK_WOSPEC[H.RANK_WOSPEC.length - 1]);
    const highestEnlistee = H.rankIndex(H.RANK_ENLISTEE[0]);
    ok(lowestOfficer < highestWospec, "every officer above every WOSPEC");
    ok(lowestWospec < highestEnlistee, "every WOSPEC above every enlistee");
  });

  await test("the ranks this company actually holds, in order", () => {
    // Cougar's real vocabulary: a few officers, a specialist command body and
    // a cohort of recruits. Pinned explicitly because this is the order a
    // commander sees on the Roster screen.
    const shuffled = ["REC", "3SG", "CPT", "PTE", "SSG", "LTA", "1SG", "MSG", "2LT", "2SG", "CFC"]
      .map(r => p(r));
    eq(ranksOf(H.sortByRank(shuffled)).join(" "),
      "CPT LTA 2LT MSG SSG 1SG 2SG 3SG CFC PTE REC");
  });

  await test("warrant officers sit above the specialists", () => {
    eq(ranksOf(H.sortByRank(["3SG", "3WO", "MSG", "CWO", "2WO"].map(r => p(r)))).join(" "),
      "CWO 2WO 3WO MSG 3SG");
  });

  await test("rank is the PRIMARY key, the caller's order is the tie-break", () => {
    const list = [
      p("3SG", "0003", "CHARLIE"), p("REC", "1101", "DELTA"),
      p("3SG", "0001", "ALPHA"), p("3SG", "0002", "BRAVO"),
    ];
    // Default tie-break: 4D.
    eq(H.sortByRank(list).map(r => r.id).join(" "), "0001 0002 0003 1101");
    // Caller-supplied tie-break: name.
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    eq(H.sortByRank(list, byName).map(r => r.name).join(" "), "ALPHA BRAVO CHARLIE DELTA");
  });

  suite("helpers: rank orders the command body, enlistees keep 4D order");

  // The whole company holds one rank now, so ordering the men by it destroys
  // the only ordering they can actually be scanned in. The 4D is a seat:
  // digit 1 is the platoon, digit 2 the section.
  await test("enlistees sort by 4D, whatever rank they carry", () => {
    const list = [e("7204"), e("7101"), e("8103", "CFC"), e("7103"), e("7102", "REC")];
    eq(H.sortByRank(list).map(r => r.id).join(" "), "7101 7102 7103 7204 8103",
      "4D order, and the CFC did not jump the queue");
  });

  await test("a caller tie-break cannot reorder the men either", () => {
    // The tie-break exists to break ties WITHIN a rank. There is no rank
    // dimension among the men, so 4D order stands.
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    const list = [e("7102", "PTE", "ALPHA"), e("7101", "PTE", "ZULU")];
    eq(H.sortByRank(list, byName).map(r => r.id).join(" "), "7101 7102", "still 4D");
  });

  await test("commanders lead the list even with no rank on the roster", () => {
    // A blank rank sorts past the bottom among commanders, but must never drop
    // a commander below the men - his row would be lost in the middle of a
    // platoon otherwise.
    const list = [e("7101"), { id: "0007", rank: "", name: "NO RANK", role: "Commander" }, e("7102")];
    eq(H.sortByRank(list).map(r => r.id).join(" "), "0007 7101 7102");
  });

  await test("a full company list: command body by rank, then the men by 4D", () => {
    const list = [
      e("8103"), p("3SG", "0003", "CHARLIE"), e("7101"), p("CPT", "0001", "ALPHA"),
      e("7102", "CFC"), p("MSG", "0002", "BRAVO"),
    ];
    eq(H.sortByRank(list).map(r => r.id).join(" "), "0001 0002 0003 7101 7102 8103");
  });

  await test("sortByRank never reorders the caller's array", () => {
    const list = [p("REC", "1101"), p("CPT", "0001")];
    const sorted = H.sortByRank(list);
    eq(list.map(r => r.rank).join(" "), "REC CPT", "input untouched");
    eq(sorted.map(r => r.rank).join(" "), "CPT REC", "copy is sorted");
    ok(sorted !== list, "a new array comes back");
  });

  await test("free-text noise normalises: case, dots, spaces", () => {
    for (const messy of ["3sg", "3SG.", " 3 S G ", "3-SG"]) {
      eq(H.rankIndex(messy), H.rankIndex("3SG"), JSON.stringify(messy) + " reads as 3SG");
    }
  });

  await test("blank and unknown ranks do not throw and sort LAST", () => {
    const bottom = H.rankIndex("REC");
    for (const bad of ["", "   ", "??", "GENERALISSIMO", null, undefined]) {
      const i = H.rankIndex(bad === null || bad === undefined ? { rank: bad } : bad);
      ok(i > bottom, "unknown rank " + JSON.stringify(bad) + " sorts below REC");
    }
    eq(H.rankIndex({}), H.rankIndex({ rank: "" }), "a record with no rank column is the same case");
    eq(H.rankIndex(null), H.rankIndex(""), "a null record does not throw");
    eq(ranksOf(H.sortByRank([p(""), p("REC"), p("CPT"), p("NOTARANK")])).join(" "),
      "CPT REC  NOTARANK", "unknowns land at the bottom, in tie-break order");
  });

  await test("sortByRank tolerates a missing / non-array list", () => {
    eq(H.sortByRank(undefined).length, 0);
    eq(H.sortByRank(null).length, 0);
    eq(H.sortByRank([]).length, 0);
  });

  await test("rankCategory still buckets off role, not rank alone", () => {
    // The CLAUDE.md rule: role and rank are different fields. A recruit is an
    // ENLISTEE whatever the rank column says, and an unrecognised commander
    // still falls back to WOSPEC so the parade strength lines add up.
    eq(H.rankCategory({ role: "Recruit", rank: "CPT" }), "ENLISTEE");
    eq(H.rankCategory({ role: "Commander", rank: "CPT" }), "OFFICER");
    eq(H.rankCategory({ role: "Commander", rank: "3SG" }), "WOSPEC");
    eq(H.rankCategory({ role: "Commander", rank: "OCT" }), "ENLISTEE");
    eq(H.rankCategory({ role: "Commander", rank: "" }), "WOSPEC");
    eq(H.rankCategory({ role: "Commander", rank: "??" }), "WOSPEC");
    eq(H.rankCategory(null), "ENLISTEE");
  });
};
