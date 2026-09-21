// ============================================================================
// depart-plan.mjs - work out everything a single man leaving the company means.
//
// Men leave mid-intake: posted out, downgraded, recoursed, back-squadded. Until
// now the only way to express that was to delete the roster row in the app,
// which is not an archive at all - it sets `deleted_at`, and purge_retention()
// then HARD-deletes that row and every child row of his once the retention
// window passes. Medical history included.
//
// A departure is therefore two things at once, and both have to happen in one
// transaction or neither is safe:
//
//   1. ARCHIVE him. Re-key his roster row and every child row from `9404` to
//      an archive key (`9404@16-out-20260921`) and soft-delete them, exactly
//      the pattern 0004 established for a change of intake. The rows stay in
//      Postgres, stay queryable, stay joined to each other - they simply leave
//      the live 4D namespace. That is also what frees the seat.
//
//   2. RENUMBER the section he leaves, so it has no hole in it. His seat is
//      freed by step 1, and the men below him move up - which makes this a
//      primary-key rename over a set that overlaps itself, the same hazard
//      reseat.mjs exists for, and it goes through the same two-phase temp-key
//      rename in scripts/depart.mjs.
//
// This file computes the plan and touches no database, so the preview and the
// apply run the SAME code and print the SAME report.
//
// WHAT MAKES IT SAFE
// ------------------
// One man is named, and he is resolved by the SAME strict matcher a swap uses
// (resolveMan in reseat-plan.mjs): a 4D, or a name that resolves to exactly one
// roster row. A near miss is ranked and reported, never accepted. Posting out
// the wrong man archives his whole medical history and hands his seat away.
// ============================================================================

import { resolveMan, rosterIndex } from "./reseat-plan.mjs";

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * The key his rows move to.
 *
 *   9404  +  intake 16  +  2026-09-21   ->   9404@16-out-20260921
 *
 * Same shape and same guarantees as archive_key() in 0004: "@" is the
 * separator because padD4 (js/state.js) passes it through untouched and no
 * real 4D can contain one, and the intake label's "/" is flattened so the key
 * stays a single path-safe token.
 *
 * It carries the DATE as well as the intake, because a departure - unlike a
 * change of intake - can happen twice to the same seat within one cohort: the
 * man who moves up into 9404 today can himself be posted out in November, and
 * a bare `9404@16` would then collide with this one and lose a man's history to
 * a primary-key conflict. `taken` closes the last of it: if the same seat is
 * vacated twice on one day, the second gets `-2`.
 */
export function departureKey(d4, intake, dateIso, taken = []) {
  const day = String(dateIso ?? "").replace(/-/g, "");
  const label = String(intake ?? "unknown").replace(/\//g, "-");
  const base = `${d4}@${label}-out-${day}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n <= 99; n++) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;   // unreachable in practice; never collide.
}

/**
 * Plan one man's departure.
 *
 * @param {object} ctx
 * @param {Array}  ctx.roster     live roster rows [{id, name, role, pid}]
 * @param {string} ctx.who        the man: a 4D, or a name
 * @param {string} [ctx.plt]      optional guard - he must be in this platoon
 * @param {string} ctx.intake     current intake label, for the archive key
 * @param {string} ctx.today      ISO date of the departure
 * @param {Array}  [ctx.takenKeys] archive keys already in use
 * @param {boolean}[ctx.renumber] close the hole he leaves (default true)
 * @returns {{ok, man, archiveKey, sect, moves, unchanged, issues}}
 */
export function planDeparture({ roster, who, plt, intake, today, takenKeys = [], renumber = true }) {
  const issues = [];
  const pltStr = plt === undefined || plt === null || plt === "" ? "" : String(plt);

  // Commanders are IN this index, unlike a swap or a re-section. A commander
  // gets posted out like anybody else; he simply holds an administrative 00xx
  // id rather than a section seat, so there is nothing to renumber after him.
  const index = rosterIndex(roster, { commanders: true });
  const man = resolveMan(index, who, "the man leaving", issues);

  if (!man) return { ok: false, man: null, archiveKey: "", sect: "", moves: [], unchanged: [], issues };

  // --plt is a guard, not a filter: if the operator says which platoon this is,
  // a name that quietly resolved into a different one is a mistake worth
  // stopping on rather than a departure worth carrying out.
  if (pltStr && man.id[0] !== pltStr) {
    issues.push({
      level: "error",
      message: `${man.id} is in platoon ${man.id[0]}, not ${pltStr}. Drop --plt if that is really him.`,
    });
    return { ok: false, man, archiveKey: "", sect: "", moves: [], unchanged: [], issues };
  }

  const archiveKey = departureKey(man.id, intake, today, takenKeys);

  // A section seat is `<plt><sect><nn>` with a non-zero platoon digit. A
  // commander's 00xx is not one, so his leaving frees nothing and renumbers
  // nothing - which is correct, not a special case worth warning about.
  const isSeat = /^[1-9]\d{3}$/.test(man.id);
  const plan = { ok: true, man, archiveKey, sect: isSeat ? man.id.slice(0, 2) : "", moves: [], unchanged: [], issues, renumbered: false };

  if (!isSeat || !renumber) return plan;

  // Everyone else in his section, dealt alphabetically into seats 1..n - the
  // ORDER convention from reseat-plan.mjs, applied to a section that is one man
  // smaller. Alphabetical rather than "shift everyone below him up one" because
  // it is reproducible from the roster alone: run it twice and the second run
  // is a no-op, which a positional shift cannot promise.
  const section = index.members
    .filter((m) => m.id.slice(0, 2) === plan.sect && m.id !== man.id && String(m.role ?? "") !== "Commander")
    .sort((a, b) => a.name.localeCompare(b.name, "en"));

  if (section.length > 99) {
    issues.push({ level: "error", message: `section ${plan.sect} has ${section.length} men; a 4D has only two digits for the seat` });
    return { ...plan, ok: false };
  }

  for (const [i, m] of section.entries()) {
    const newId = `${plan.sect}${pad2(i + 1)}`;
    (newId === m.id ? plan.unchanged : plan.moves).push({ oldId: m.id, newId, name: m.name, pid: m.pid ?? null });
  }

  // The deal must be a permutation of the seats. Cheap, and it is the last
  // thing standing between a bug here and two roster rows colliding on a
  // primary key mid-transaction.
  const newIds = plan.moves.map((m) => m.newId);
  if (new Set(newIds).size !== newIds.length) {
    issues.push({ level: "error", message: "internal: two men were dealt the same 4D" });
    return { ...plan, ok: false };
  }

  // He must not be dealt a seat by his own departure. He is filtered out of the
  // section above, so this can only fail if that filter ever stops working -
  // which would hand him a live seat and archive him in the same transaction.
  if (plan.moves.some((m) => m.oldId === man.id)) {
    issues.push({ level: "error", message: "internal: the departing man is still in the deal" });
    return { ...plan, ok: false };
  }

  plan.moves.sort((a, b) => a.newId.localeCompare(b.newId));
  plan.renumbered = true;
  return plan;
}

/** The report. Identical for a preview and an apply, by design. */
export function formatDepartReport(plan, { names = false, carries = null, reason = "" } = {}) {
  const L = [];
  const who = (m) => (names ? `  ${m.name}` : "");

  L.push("─".repeat(72));
  L.push("DEPARTURE");
  L.push("");

  if (plan.man) {
    L.push(`  ${plan.man.id}${names ? `  ${plan.man.name}` : ""}  leaves the company`);
    L.push(`  archived as  ${plan.archiveKey}`);
    if (reason) L.push(`  reason       ${reason}`);
    if (carries && Object.keys(carries).length) {
      L.push(`  carries      ${Object.entries(carries).map(([t, n]) => `${t} ${n}`).join(", ")}`);
    } else if (carries) {
      L.push("  carries      nothing - no records under this 4D");
    }
    L.push("");
  }

  if (plan.ok && plan.sect) {
    if (!plan.renumbered) {
      L.push(`  Section ${plan.sect} is NOT renumbered - ${plan.man.id} is left vacant.`);
      L.push("");
    } else if (plan.moves.length) {
      L.push(`  SECTION ${plan.sect} renumbered - ${plan.moves.length} of ${plan.moves.length + plan.unchanged.length} 4Ds change`);
      for (const m of plan.moves) L.push(`    ${m.newId}  <- ${m.oldId}${who(m)}`);
      L.push("");
    } else {
      L.push(`  Section ${plan.sect} needs no renumbering - he held the last seat.`);
      L.push("");
    }
  }

  const errors = plan.issues.filter((i) => i.level === "error");
  if (errors.length) {
    L.push(`BLOCKED - ${errors.length} issue(s) to settle:`);
    L.push("");
    for (const e of errors) {
      L.push(`  ✗ ${e.message}`);
      for (const c of e.candidates ?? []) {
        L.push(`      ${c.id}  ${(c.score * 100).toFixed(0)}%${names ? `  ${c.name}` : ""}`);
      }
      if (e.fix) L.push(`      did you mean:  ${e.fix}`);
      L.push("");
    }
    L.push("Nothing was written.");
  } else {
    L.push("READY");
  }
  return L.join("\n");
}
