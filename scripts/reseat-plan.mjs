// ============================================================================
// reseat-plan.mjs — work out every 4D change a re-sectioning implies.
//
// A 4D is a SEAT, not a person: digit 1 is the platoon, digit 2 the section and
// the last two are the person's place in that section. So when a platoon is
// re-sectioned — the same men, dealt into different sections — the seats have
// to be re-dealt too, and roster.id IS the 4D and IS the primary key.
//
// This file computes the plan and nothing else. It touches no database, which
// is what lets the preview and the apply run the SAME code and print the SAME
// report, so what the operator reads is exactly what runs. scripts/reseat.mjs
// is the thin runner around it.
//
// THE ONE RULE THAT MAKES THIS SAFE
// ---------------------------------
// A re-section is a CLOSED SET: the men listed must be exactly the men the
// platoon already has, matched one-to-one. That constraint is load-bearing —
// it means a mis-match cannot quietly move one person's medical history onto
// another, because a wrong pairing leaves somebody unmatched on each side and
// the whole run stops. Every check below exists to keep that property.
// ============================================================================

import { nameKey, nameTokens, padD4 } from "./intake-plan.mjs";

// Sequence within a section is ALPHABETICAL BY NAME, which is how the roster
// has always been numbered. Deliberately not the order the operator's list
// happens to be in: those lists are written in appointment order (drivers,
// then gunners, then troopers) and that order changes with every vehicle
// reshuffle, which would churn everybody's 4D for no reason. Alphabetical is
// stable, reproducible from the roster alone, and leaves a section whose
// membership did not change with the numbers it already had.
export const ORDER = "alphabetical";

/**
 * Parse the section list an operator pastes in — the real artifact, straight
 * out of a chat message, em dashes, emoji, stray commas and all.
 *
 *   SECTION 1 — 9
 *   LI WEI — 🔵 Hunter Driver
 *   NG SOON KIT, DARREN — 🟢 AI
 *   ZAKIR MAHFUZ BIN OMAR [5101] — 🟢 AI
 *
 * (Invented names. This repository is public; real ones never go in it.)
 *
 * A trailing `[4D]` PINS that line to a specific roster row. It is how the
 * operator settles a name the matcher will not guess at — see planReseat.
 *
 * The em dash is the field separator and a plain hyphen is NOT, because names
 * contain hyphens ("NUR-HAKIM BIN SALLEH") and splitting on those would truncate
 * them. A line with no dash at all is taken as a bare name.
 */
export function parseSections(text) {
  const sections = [];
  let current = null;
  const issues = [];

  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;

    const head = line.match(/^SECTION\s+(\d+)\b/i);
    if (head) {
      current = { sect: Number(head[1]), members: [] };
      sections.push(current);
      return;
    }

    if (!current) {
      issues.push({ level: "error", line: i + 1, message: `"${line}" appears before any SECTION header` });
      return;
    }

    // Everything before the first em dash is the name; the rest is the role,
    // which this tool does not model and deliberately ignores.
    const [namePart = ""] = line.split("—");
    let name = namePart.trim();

    let pin = "";
    const pinned = name.match(/\[\s*([A-Za-z]?\d{3,4})\s*\]\s*$/);
    if (pinned) {
      pin = padD4(pinned[1]);
      name = name.slice(0, pinned.index).trim();
    }

    // A comma is punctuation in "NG SOON KIT, DARREN", never a field separator.
    name = name.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (!name) {
      issues.push({ level: "error", line: i + 1, message: `line ${i + 1} has no name` });
      return;
    }
    current.members.push({ name, pin, line: i + 1 });
  });

  return { sections, issues };
}

// Dice coefficient over character bigrams. Used ONLY to rank candidates in the
// report an operator reads — never to accept a match.
//
// It is here because token-set similarity, which is what the intake matcher
// uses, is blind to the failure mode this tool actually meets: a single
// mistyped character INSIDE a token. "MAHFUZ" against "MAHFOOZ" shares no
// token at all and scores 0, while a human reads them as obviously the same
// man. Bigrams see the overlap. That is a good reason to rank with it and a
// terrible reason to trust it, so it ranks and the human decides.
export function bigramSimilarity(a, b) {
  const grams = (s) => {
    const t = String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const out = new Map();
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  const na = [...ga.values()].reduce((s, n) => s + n, 0);
  const nb = [...gb.values()].reduce((s, n) => s + n, 0);
  if (!na || !nb) return 0;
  let hits = 0;
  for (const [g, n] of ga) hits += Math.min(n, gb.get(g) ?? 0);
  return (2 * hits) / (na + nb);
}

/** How alike two names look, for ranking. Best of token-set and bigram. */
export function rankScore(a, b) {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  const tokenSet = ta.size && tb.size ? hits / Math.min(ta.size, tb.size) : 0;
  return Math.max(tokenSet, bigramSimilarity(a, b));
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Plan a re-section.
 *
 * @param {object} ctx
 * @param {number|string} ctx.plt   platoon being re-sectioned, e.g. 9
 * @param {Array}  ctx.roster       live roster rows [{id, name, role, ...}]
 * @param {Array}  ctx.sections     from parseSections()
 * @returns {{ok, plt, moves, unchanged, sections, issues, byPid}}
 */
export function planReseat({ plt, roster, sections }) {
  const pltStr = String(plt);
  const issues = [];

  // ── 1. Who is in this platoon today ───────────────────────────────────────
  //
  // Commanders (00xx) are coy-level and hold no section seat, so they are not
  // part of a re-section even if one happens to be posted to the platoon.
  const members = roster
    .filter((r) => {
      const id = padD4(r.id);
      return /^\d{4}$/.test(id) && id[0] === pltStr && String(r.role ?? "") !== "Commander";
    })
    .map((r) => ({ ...r, id: padD4(r.id) }));

  if (!members.length) {
    issues.push({ level: "error", message: `no recruits found in platoon ${pltStr}` });
    return { ok: false, plt: pltStr, moves: [], unchanged: [], sections: [], issues, byPid: new Map() };
  }

  const listed = sections.flatMap((s) => s.members.map((m) => ({ ...m, sect: s.sect })));

  // ── 2. Match each listed name to exactly one roster row ───────────────────
  //
  // Exact token-set key, or an explicit [4D] pin. Nothing else. A near match is
  // reported with its candidates and STOPS the run, because the cost of being
  // wrong is one recruit silently inheriting another's medical history and
  // nothing downstream ever flagging it.
  const byId = new Map(members.map((m) => [m.id, m]));
  const byKey = new Map();
  for (const m of members) {
    const k = nameKey(m.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m);
  }

  const takenBy = new Map();   // roster id -> listed entry that claimed it
  const matched = [];          // { entry, member }

  for (const entry of listed) {
    let member = null;
    let how = "";

    if (entry.pin) {
      member = byId.get(entry.pin) ?? null;
      how = "pin";
      if (!member) {
        issues.push({
          level: "error",
          message: `line ${entry.line}: "${entry.name}" is pinned to ${entry.pin}, which is not a recruit in platoon ${pltStr}`,
        });
        continue;
      }
    } else {
      const hits = byKey.get(nameKey(entry.name)) ?? [];
      if (hits.length === 1) {
        member = hits[0];
        how = "name";
      } else if (hits.length > 1) {
        issues.push({
          level: "error",
          message:
            `line ${entry.line}: "${entry.name}" matches ${hits.length} recruits ` +
            `(${hits.map((h) => h.id).join(", ")}). Pin the right one: "${entry.name} [<4D>]".`,
        });
        continue;
      }
    }

    if (!member) {
      // Rank what is still free so the operator has something to act on.
      const free = members.filter((m) => !takenBy.has(m.id));
      const ranked = free
        .map((m) => ({ id: m.id, name: m.name, score: rankScore(entry.name, m.name) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      issues.push({
        level: "error",
        message: `line ${entry.line}: no recruit in platoon ${pltStr} is named "${entry.name}".`,
        candidates: ranked,
        fix: ranked.length ? `${entry.name} [${ranked[0].id}]` : "",
      });
      continue;
    }

    const clash = takenBy.get(member.id);
    if (clash) {
      issues.push({
        level: "error",
        message:
          `line ${entry.line}: "${entry.name}" and line ${clash.line} ("${clash.name}") ` +
          `both resolve to ${member.id}. One of them is the wrong man.`,
      });
      continue;
    }
    takenBy.set(member.id, entry);
    matched.push({ entry, member, how });
  }

  // ── 3. The closed-set check ───────────────────────────────────────────────
  //
  // This is the check that makes the rest safe. Anyone on the roster but not on
  // the list would keep a seat in a section that no longer exists as listed;
  // anyone on the list but not the roster has no record to move. Either way the
  // one-to-one property is gone, so the run stops.
  const missing = members.filter((m) => !takenBy.has(m.id));
  if (missing.length) {
    issues.push({
      level: "error",
      message:
        `${missing.length} recruit(s) in platoon ${pltStr} are not on the list: ` +
        missing.map((m) => m.id).join(", ") +
        `. A re-section must account for the whole platoon — add them, or post them out first.`,
    });
  }

  if (issues.some((i) => i.level === "error")) {
    return { ok: false, plt: pltStr, moves: [], unchanged: [], sections: [], issues, byPid: new Map() };
  }

  // ── 4. Deal the seats ─────────────────────────────────────────────────────
  const bySect = new Map();
  for (const { entry, member } of matched) {
    if (!bySect.has(entry.sect)) bySect.set(entry.sect, []);
    bySect.get(entry.sect).push(member);
  }

  const assigned = new Map();  // old id -> new id
  const layout = [];
  for (const sect of [...bySect.keys()].sort((a, b) => a - b)) {
    // The roster's spelling, not the list's — the list is typed by hand and the
    // roster row is the record of who this person is.
    const seats = [...bySect.get(sect)].sort((a, b) => a.name.localeCompare(b.name, "en"));
    if (seats.length > 99) {
      issues.push({ level: "error", message: `section ${sect} has ${seats.length} men; a 4D has only two digits for the seat` });
      continue;
    }
    const rows = seats.map((m, i) => {
      const newId = `${pltStr}${sect}${pad2(i + 1)}`;
      assigned.set(m.id, newId);
      return { oldId: m.id, newId, name: m.name, pid: m.pid ?? null };
    });
    layout.push({ sect, rows });
  }

  if (issues.some((i) => i.level === "error")) {
    return { ok: false, plt: pltStr, moves: [], unchanged: [], sections: layout, issues, byPid: new Map() };
  }

  // ── 5. Sanity: the deal must be a permutation of the seats ────────────────
  //
  // Cheap, and it is the last thing standing between a bug here and two roster
  // rows colliding on a primary key mid-transaction.
  const newIds = [...assigned.values()];
  if (new Set(newIds).size !== newIds.length) {
    issues.push({ level: "error", message: "internal: two men were dealt the same 4D" });
    return { ok: false, plt: pltStr, moves: [], unchanged: [], sections: layout, issues, byPid: new Map() };
  }

  const moves = [];
  const unchanged = [];
  for (const { oldId, newId, name, pid } of layout.flatMap((s) => s.rows)) {
    (oldId === newId ? unchanged : moves).push({ oldId, newId, name, pid });
  }
  moves.sort((a, b) => a.newId.localeCompare(b.newId));

  return {
    ok: true,
    plt: pltStr,
    moves,
    unchanged,
    sections: layout,
    issues,
    byPid: new Map(moves.filter((m) => m.pid).map((m) => [m.pid, m])),
  };
}

/** The report. Identical for a preview and an apply, by design. */
export function formatReseatReport(plan, { names = false } = {}) {
  const L = [];
  const who = (m) => (names ? `  ${m.name}` : "");

  L.push(`RE-SECTION — platoon ${plan.plt}`);
  L.push("");

  for (const s of plan.sections) {
    L.push(`  SECTION ${s.sect} — ${s.rows.length}`);
    for (const r of s.rows) {
      const mark = r.oldId === r.newId ? "  (unchanged)" : `  <- ${r.oldId}`;
      L.push(`    ${r.newId}${mark}${who(r)}`);
    }
    L.push("");
  }

  if (plan.ok) {
    L.push(`  ${plan.moves.length} of ${plan.moves.length + plan.unchanged.length} 4Ds change.`);
    L.push("");
  }

  const errors = plan.issues.filter((i) => i.level === "error");
  if (errors.length) {
    L.push(`BLOCKED — ${errors.length} issue(s) to settle:`);
    L.push("");
    for (const e of errors) {
      L.push(`  ✗ ${e.message}`);
      for (const c of e.candidates ?? []) {
        L.push(`      ${c.id}  ${(c.score * 100).toFixed(0)}%${names ? `  ${c.name}` : ""}`);
      }
      if (e.fix) L.push(`      if that is him, change the line to:  ${e.fix}`);
      L.push("");
    }
    L.push("Nothing was written.");
  } else {
    L.push("READY");
  }
  return L.join("\n");
}

// ── A two-man seat swap ──────────────────────────────────────────────────────
//
// Re-dealing a whole platoon assigns 4Ds by POSITION in the list, so a man who
// did not move sections still changes seat if the men above him did. When the
// real-world change is "these two exchange sections", that churn is noise: it
// re-issues invites, invalidates every phone's cache for men who did not move,
// and writes intake_log rows for changes that did not happen.
//
// A swap is the minimal, exact expression of that change: two men exchange
// their existing 4Ds and nobody else is touched. It reuses the same apply path
// as a re-section, so the same two-phase rename, the same catalogue-discovered
// child tables and the same single transaction still hold.
//
// Resolution is deliberately as strict as the re-section matcher. A man is
// named by his 4D, or by a name that resolves to exactly ONE roster row. A near
// miss is ranked and reported, never accepted: the cost of being wrong here is
// two men swapping each other's medical history.
/**
 * Index the roster once, the way both the swap and the departure matcher need
 * it: by 4D and by name key, over the men who actually hold a seat.
 *
 * Commanders hold an administrative 00xx id and no section seat, so they are
 * out by default — a re-section or a swap cannot involve them. A departure
 * can: a commander gets posted out like anybody else, he simply has no seat to
 * free. That is the whole reason this takes an option.
 */
export function rosterIndex(roster, { commanders = false } = {}) {
  const members = roster
    .filter((r) => /^\d{4}$/.test(padD4(r.id)) && (commanders || String(r.role ?? "") !== "Commander"))
    .map((r) => ({ ...r, id: padD4(r.id) }));

  const byId = new Map(members.map((m) => [m.id, m]));
  const byKey = new Map();
  for (const m of members) {
    const k = nameKey(m.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m);
  }
  return { members, byId, byKey };
}

/**
 * Name one man, exactly. A 4D, or a name that resolves to exactly ONE roster
 * row; anything else pushes an issue and returns null.
 *
 * Shared by the swap and the departure on purpose. Both operations re-key a
 * primary key on the strength of this answer, and the cost of a near miss —
 * one man inheriting another's medical history, or the wrong man being posted
 * out — is identical. Two copies of a matcher this load-bearing would drift.
 */
export function resolveMan(index, raw, side, issues) {
  const want = String(raw ?? "").trim();
  if (!want) {
    issues.push({ level: "error", message: `${side}: no man given` });
    return null;
  }

  // A bare 4D is unambiguous, so it wins outright and skips name matching.
  if (/^[A-Za-z]?\d{3,4}$/.test(want)) {
    const id = padD4(want);
    const hit = index.byId.get(id);
    if (!hit) {
      issues.push({ level: "error", message: `${side}: ${id} is not an enlistee on the current roster` });
      return null;
    }
    return { ...hit, how: "4d" };
  }

  const hits = index.byKey.get(nameKey(want)) ?? [];
  if (hits.length === 1) return { ...hits[0], how: "name" };
  if (hits.length > 1) {
    issues.push({
      level: "error",
      message:
        `${side}: "${want}" matches ${hits.length} men (${hits.map((h) => h.id).join(", ")}). ` +
        `Name him by 4D instead.`,
    });
    return null;
  }

  const ranked = index.members
    .map((m) => ({ id: m.id, name: m.name, score: rankScore(want, m.name) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 3);
  issues.push({
    level: "error",
    message: `${side}: nobody on the roster is named "${want}".`,
    candidates: ranked,
    fix: ranked.length ? ranked[0].id : "",
  });
  return null;
}

export function planSwap({ plt, roster, a, b }) {
  const issues = [];
  const pltStr = plt === undefined || plt === null || plt === "" ? "" : String(plt);

  const index = rosterIndex(roster);
  const resolve = (raw, side) => resolveMan(index, raw, side, issues);

  const ma = resolve(a, "first man");
  const mb = resolve(b, "second man");
  if (!ma || !mb) return { ok: false, plt: pltStr, moves: [], issues, pair: [ma, mb] };

  if (ma.id === mb.id) {
    issues.push({ level: "error", message: `both names resolve to the same man (${ma.id}). Nothing to swap.` });
    return { ok: false, plt: pltStr, moves: [], issues, pair: [ma, mb] };
  }

  // --plt is an optional guard, not a filter: if the operator says which
  // platoon this is, a name that quietly resolved into a different one is a
  // mistake worth stopping on rather than a swap worth making.
  if (pltStr) {
    for (const m of [ma, mb]) {
      if (m.id[0] !== pltStr) {
        issues.push({
          level: "error",
          message: `${m.id} (${m.name}) is in platoon ${m.id[0]}, not ${pltStr}. Drop --plt to swap across platoons.`,
        });
      }
    }
    if (issues.length) return { ok: false, plt: pltStr, moves: [], issues, pair: [ma, mb] };
  }

  const moves = [
    { oldId: ma.id, newId: mb.id, name: ma.name, pid: ma.pid ?? null },
    { oldId: mb.id, newId: ma.id, name: mb.name, pid: mb.pid ?? null },
  ];
  return { ok: true, plt: pltStr, moves, issues, pair: [ma, mb] };
}

export function formatSwapReport(plan, { names = false } = {}) {
  const L = [];
  const who = (m) => (names ? `  ${m.name}` : "");
  L.push("─".repeat(72));
  L.push(`SWAP${plan.plt ? `  platoon ${plan.plt}` : ""}`);
  L.push("");
  if (plan.moves.length === 2) {
    const [x, y] = plan.moves;
    L.push(`  ${x.oldId} -> ${x.newId}${who(x)}`);
    L.push(`  ${y.oldId} -> ${y.newId}${who(y)}`);
    L.push("");
    L.push("  Nobody else moves.");
  }
  if (plan.issues.length) {
    L.push("");
    for (const i of plan.issues) {
      L.push(`✗ ${i.message}`);
      for (const c of i.candidates ?? []) {
        L.push(`    ${c.id}  ${(c.score * 100).toFixed(0)}%${names ? "  " + c.name : ""}`);
      }
      if (i.fix) L.push(`    did you mean: ${i.fix}`);
    }
  }
  L.push("");
  L.push(plan.ok ? "READY" : "BLOCKED");
  return L.join("\n");
}
