// ============================================================================
// promote-plan.mjs - work out every roster.rank change a promotion implies.
//
// `role` and `rank` are different fields and only one of them moves. `role` is
// the two-valued Commander / Recruit switch the whole app scopes on; `rank` is
// REC, PTE, 3SG. A cohort enlists as REC and is promoted to PTE on posting into
// unit training, and the parade state is read against the battalion's nominal
// roll, so the column has to follow the man.
//
// This file computes the plan and nothing else. It touches no database, which
// is what lets the preview and the apply run the SAME code and print the SAME
// report, so what the operator reads is exactly what runs. scripts/promote.mjs
// is the thin runner around it. Same split as reseat-plan.mjs / reseat.mjs.
//
// THE RULES THAT MAKE THIS SAFE
// -----------------------------
// 1. A COMMANDER IS NEVER TOUCHED. A rank promotion is a thing that happens to
//    the enlistee cohort; a 3SG rewritten to PTE is a demotion the app would
//    render on every parade state, and nothing downstream would flag it. The
//    filter is on `role`, never on the current rank - scoping on rank to decide
//    role is the exact confusion this repository warns about.
// 2. ANY OTHER RANK ALREADY ON AN ENLISTEE ROW BLOCKS THE RUN. Blank and REC
//    are the two shapes a not-yet-promoted enlistee row has; anything else
//    (LCP, CPL, a mis-filed 3SG) is somebody who already moved, and writing PTE
//    over it is a silent demotion. Those rows are listed and the run stops
//    until the operator passes --force, which is them saying "yes, those too".
// 3. IT IS IDEMPOTENT. A row already holding the target rank is not a write.
//    Running twice changes nothing, so a half-finished run is safe to repeat.
// ============================================================================

/** The rank a posting into unit training confers. The default target. */
export const DEFAULT_RANK = "PTE";

/**
 * What a blank rank renders as. `rosterRank()` in js/forms.js falls back to
 * this, so a blank row and a literal "REC" row are the same thing on screen -
 * and both are a row that has not been promoted yet.
 */
export const UNPROMOTED = "REC";

/** Ranks that are legal to write. Kept in step with RANK_ENLISTEE in js/helpers.js. */
export const ENLISTEE_RANKS = ["REC", "PTE", "PFC", "LCP", "CPL", "CFC", "SCT", "OCT"];

const norm = (v) => String(v ?? "").trim().toUpperCase();

/** The same Commander test the frontend uses: `role`, never rank. */
const isCommander = (r) => String(r?.role ?? "").trim().toLowerCase() === "commander";

/**
 * @param {object}   opts
 * @param {Array}    opts.roster  roster rows: { id, name, role, rank, pid }
 * @param {string}  [opts.rank]   the target rank (default PTE)
 * @param {boolean} [opts.force]  promote enlistees already holding some other rank
 */
export function planPromotion({ roster = [], rank = DEFAULT_RANK, force = false } = {}) {
  const target = norm(rank);
  const issues = [];

  if (!ENLISTEE_RANKS.includes(target)) {
    issues.push({
      level: "error",
      message: `"${rank}" is not an enlistee rank. One of: ${ENLISTEE_RANKS.join(", ")}.`,
    });
    return { ok: false, rank: target, promote: [], candidates: [], already: [], commanders: [], blocked: [], issues };
  }

  const promote = [];   // rows this run would write
  const already = [];   // rows already at the target - the idempotence set
  const blocked = [];   // enlistees holding some other rank
  const commanders = [];

  for (const r of roster) {
    const id = String(r?.id ?? "");
    if (!id) continue;
    const entry = { id, name: String(r?.name ?? ""), from: norm(r?.rank), pid: r?.pid ?? null };

    if (isCommander(r)) { commanders.push(entry); continue; }
    if (entry.from === target) { already.push(entry); continue; }

    // Blank and REC are the two shapes of a not-yet-promoted enlistee row.
    if (entry.from === "" || entry.from === UNPROMOTED) { promote.push(entry); continue; }

    blocked.push(entry);
    if (force) promote.push(entry);
  }

  if (blocked.length && !force) {
    // Capped. A whole cohort can land in here at once - target LCP against a
    // company that is already PTE and it is every man - and a wall of 4Ds is
    // a thing an operator scrolls past rather than reads.
    const shown = blocked.slice(0, 12).map((b) => `${b.id} (${b.from})`).join(", ");
    const rest = blocked.length > 12 ? `, and ${blocked.length - 12} more` : "";
    issues.push({
      level: "error",
      message:
        `${blocked.length} enlistee row(s) already hold a different rank: ${shown}${rest}. ` +
        `Writing ${target} over those would be a demotion. Re-run with --force if that is what you mean.`,
    });
  }

  promote.sort((a, b) => a.id.localeCompare(b.id));

  // A blocked plan carries NO writes at all, the same way a blocked re-section
  // carries no moves. The report is for reading; a caller must not be able to
  // reach a partial set of rows out of a plan that said stop.
  const ok = !issues.some((i) => i.level === "error");
  return { ok, rank: target, promote: ok ? promote : [], candidates: promote, already, commanders, blocked, issues };
}

/** The report. Identical for a preview and an apply, by design. */
export function formatPromotionReport(plan, { names = false } = {}) {
  const L = [];
  const who = (m) => (names ? `  ${m.name}` : "");

  L.push(`PROMOTE - every enlistee to ${plan.rank}`);
  L.push("");
  L.push(`  ${plan.commanders.length} commander(s) - untouched, always.`);
  L.push(`  ${plan.already.length} enlistee(s) already ${plan.rank}.`);
  const candidates = plan.candidates ?? plan.promote;
  L.push(`  ${candidates.length} enlistee(s) would change.`);
  L.push("");

  if (candidates.length) {
    for (const m of candidates) {
      L.push(`    ${m.id}  ${m.from || "(blank)"} -> ${plan.rank}${who(m)}`);
    }
    L.push("");
  }

  // Only when the operator forced past them. Unforced, the same ids are about
  // to be printed in full in the BLOCKED issue below, and printing a hundred
  // 4Ds twice is how a report stops being read.
  if (plan.blocked.length && plan.ok) {
    L.push(`  Forced past ${plan.blocked.length} row(s) that held another rank: ` +
      plan.blocked.map((b) => `${b.id} ${b.from}`).join(", "));
    L.push("");
  }

  const errors = plan.issues.filter((i) => i.level === "error");
  if (errors.length) {
    L.push(`BLOCKED - ${errors.length} issue(s) to settle:`);
    L.push("");
    for (const e of errors) L.push(`  x ${e.message}`);
    L.push("");
    L.push("Nothing was written.");
  } else if (!candidates.length) {
    L.push("READY - nothing to do. Every enlistee already holds this rank.");
  } else {
    L.push("READY");
  }
  return L.join("\n");
}
