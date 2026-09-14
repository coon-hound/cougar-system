#!/usr/bin/env node
// ============================================================================
// Issue, list and revoke access to the Cougar System.
//
// There is no username and no password. An INVITE IS THE CREDENTIAL: a row in
// `invites` handed out as a URL. Opening it calls the public `redeemInvite`
// action, which mints a per-device row in `auth_tokens` that stays valid for 90
// days. Whoever opens the link becomes that person — in the app and in every
// audit-log entry. So a link is sent to ONE person, individually. A link in a
// group chat is a shared account with someone else's name on the audit trail.
//
// ONE PRE-LABELLED INVITE PER PERSON
//   The invite carries `person` and `d4` from the moment it is created, and the
//   Edge Function copies them (with `device_label`) onto the auth_tokens row on
//   redemption. That is the whole point of this script: before it, invites were
//   hand-written SQL and carried no identity, so everyone who joined showed up
//   as a raw UUID in the access list and in the audit log. Identity has to be
//   attached at ISSUE time, because redemption is anonymous by construction —
//   the person clicking the link never tells us who they are.
//
// 4D CANONICALISATION
//   `d4` is stored digit-only and zero-padded ("C1101" → "1101", "1" → "0001"),
//   mirroring padD4 (js/state.js:305). The roster's "id" is already canonical;
//   roster."4d" is the C-prefixed DISPLAY form. Storing the display form here
//   would break every join against roster."id".
//
// FOUR STATES, ONE PREDICATE
//   An invite is usable only when it is not revoked, has uses left, and has not
//   expired (inviteUsable). Those three independent ways of being dead are what
//   `inviteStatus` reports as revoked / redeemed / expired, with `open` for the
//   usable case — so "open" and "usable" are the same claim, made once. Killing
//   an invite sets `revoked_at`; it deliberately does NOT touch `max_uses`,
//   because a count pulled down to hide an invite would then be indistinguish-
//   able from one that was genuinely redeemed.
//
// DRY RUN BY DEFAULT
//   Anything that creates or revokes prints what it would do and writes
//   nothing until `--commit`, matching migrate-from-sheets.mjs and
//   purge_retention(). Issuing credentials to 280-odd people is not an
//   operation to discover a typo in after the fact.
//
// RE-RUNNING --from-roster IS SAFE
//   It skips anyone who already holds a live (not revoked, not expired) token,
//   and anyone who already has a usable invite outstanding, naming each one it
//   skipped. Re-running after adding three people to the roster issues three
//   invites, not 283.
//
// Usage:
//   DATABASE_URL=... node scripts/issue-invites.mjs --person "CPT Tan Wei Ming" --d4 1101 \
//                                                   [--device phone] [--days 14] [--uses 1] [--commit]
//   DATABASE_URL=... node scripts/issue-invites.mjs --from-roster --role Commander [--plt 1] [--days 14] [--commit]
//   DATABASE_URL=... node scripts/issue-invites.mjs --list [--json]
//   DATABASE_URL=... node scripts/issue-invites.mjs --revoke-token  <auth token> [--commit]
//   DATABASE_URL=... node scripts/issue-invites.mjs --revoke-invite <invite token> [--commit]
//
// Options common to the issuing modes:
//   --days N        invite expiry in days (default 14). The invite expiring is
//                   not the access expiring: a redeemed token lives 90 days.
//   --uses N        max redemptions (default 1 — one person, one device)
//   --device LABEL  device_label stamped on the token (default "device")
//   --base-url URL  link prefix (default the deployed GitHub Pages app)
//   --reissue       with --from-roster, do not skip people who already have a
//                   usable invite outstanding (still skips live token holders)
//   --json          with --list, emit machine-readable JSON and nothing else,
//                   so the outstanding list can be pasted or piped to jq
//                   instead of scraped out of a fixed-width table
//
// The pure helpers below (padD4 / inviteUsable / inviteStatus) are exported and
// unit-tested in test/issue-invites.test.js; the driver runs only when this
// file is the entry point, so importing it opens no database connection.
// ============================================================================

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const DEFAULT_BASE_URL = "https://coon-hound.github.io/cougar-system/";

// ─── Pure logic (exported for test/issue-invites.test.js) ───────────────────

// Mirrors padD4 (js/state.js:305). Copied, not imported: js/ is browser
// globals, not modules, and this script must not depend on the front end.
export const padD4 = (d4) => {
  const s = String(d4 ?? "").trim().replace(/^C/i, "");
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
};

// The single definition of "this invite can still be redeemed", matching the
// checks redeemInvite() makes in the Edge Function. Everything that decides
// whether to skip a person, or what to print, goes through here — two copies of
// this rule that drift is how someone ends up re-invited or silently locked out.
export const inviteUsable = (inv, now = new Date()) =>
  !!inv &&
  inv.revoked_at == null &&
  Number(inv.used_count) < Number(inv.max_uses) &&
  (inv.expires_at == null || new Date(inv.expires_at) > now);

// The four states an invite can be in, in precedence order. Revocation is an
// explicit administrative act, so it outranks the passive ways of being dead:
// an invite that was killed reads "revoked" even if it had also been redeemed
// or expired. Whether the DEVICE it produced still has access is a separate
// question, answered by the live-token list — never by this label.
export const inviteStatus = (inv, now = new Date()) => {
  if (inv.revoked_at != null) return "revoked";
  if (Number(inv.used_count) >= Number(inv.max_uses)) return "redeemed";
  if (inv.expires_at != null && new Date(inv.expires_at) <= now) return "expired";
  return "open";
};

// ─── CLI plumbing ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};
const num = (name, fallback) => {
  const v = flag(name);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) die(`${name} must be a positive number, got "${v}"`);
  return n;
};

function die(msg) {
  console.error(`\n  ERROR  ${msg}\n`);
  process.exit(1);
}

// Populated by main(); read by the mode functions. Kept out of module scope so
// that importing this file for its pure helpers parses no arguments and, in
// particular, never calls die() on the test runner's own argv.
const opt = {};

const link = (token) => `${opt.baseUrl}${opt.baseUrl.includes("?") ? "&" : "?"}token=${token}`;
const fmt = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—");
const pad = (s, n) => String(s ?? "").padEnd(n);

const CREDENTIAL_WARNING = [
  "  ─────────────────────────────────────────────────────────────────────────",
  "  An invite link IS a credential. There is no password behind it: whoever",
  "  opens it becomes that person in the app AND in the audit log.",
  "  Send each link to its one person directly. Never to a group chat.",
  "  ─────────────────────────────────────────────────────────────────────────",
].join("\n");

let sql;

// ─── Preflight ──────────────────────────────────────────────────────────────
// The identity and revocation columns are added by migration 0003. Without them
// this script would issue anonymous invites — exactly the problem it exists to
// fix — or accept a --revoke-invite that quietly revokes nothing. Either is
// worse than refusing to run, so an older database fails here and loudly.
async function preflight() {
  const cols = await sql`
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('invites', 'auth_tokens')`;
  const present = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
  const need = ["invites.person", "invites.d4", "invites.device_label", "invites.revoked_at"];
  const missing = need.filter((c) => !present.has(c));
  if (missing.length) {
    die(
      `this database is missing invite columns: ${missing.join(", ")}.\n` +
        `         Apply migration 0003 before issuing or revoking invites.`
    );
  }
  // auth_tokens.d4 ships in the same migration but is only read here, so a
  // database without it degrades to matching live holders by person name
  // rather than failing outright.
  return { tokenD4: present.has("auth_tokens.d4") };
}

// ─── Who already has access ─────────────────────────────────────────────────
async function liveTokens(tokenD4) {
  return await sql`
    select token, person, ${tokenD4 ? sql`d4` : sql`null::text as d4`},
           device_label, issued_at, expires_at, last_seen_at
      from auth_tokens
     where revoked_at is null
       and expires_at > now()
     order by person nulls last, issued_at`;
}

async function allInvites() {
  return await sql`
    select token, person, d4, device_label, max_uses, used_count,
           created_at, expires_at, revoked_at, redemptions
      from invites
     order by created_at desc`;
}

// ─── Issue ──────────────────────────────────────────────────────────────────
// One row per person. Returns the row it wrote (or would write).
async function issue({ person, d4, device }) {
  const token = crypto.randomUUID();
  if (opt.commit) {
    await sql`
      insert into invites (token, person, d4, device_label, max_uses, expires_at)
      values (${token}, ${person}, ${d4}, ${device}, ${opt.uses},
              now() + ${`${opt.days} days`}::interval)`;
  }
  return { token, person, d4, device };
}

function printIssued(rows) {
  const wName = Math.max(4, ...rows.map((r) => (r.person || "").length));
  console.log(`\n  ${pad("NAME", wName)}  4D    LINK`);
  for (const r of rows) console.log(`  ${pad(r.person, wName)}  ${pad(r.d4, 4)}  ${link(r.token)}`);
  console.log(`\n  ${rows.length} invite(s) ${opt.commit ? "created" : "WOULD be created"}, ` +
    `${opt.uses} use(s) each, expiring in ${opt.days} day(s).`);
  console.log(CREDENTIAL_WARNING);
  if (!opt.commit) console.log("\n  DRY RUN — nothing was written. Re-run with --commit.\n");
  else console.log("");
}

// Same person? d4 is authoritative when both sides have one; the name is the
// fallback for rows predating the identity columns.
const samePerson = (a, b) =>
  (a.d4 && b.d4 && a.d4 === b.d4) ||
  (!!a.person && !!b.person && a.person.toUpperCase() === b.person.toUpperCase());

// ─── Modes ──────────────────────────────────────────────────────────────────

async function modeOne({ tokenD4 }) {
  const person = String(flag("--person", "")).trim();
  const d4 = padD4(flag("--d4", ""));
  if (!person) die("--person is required.");
  if (!/^\d{4}$/.test(d4)) die(`--d4 must be a 4D like 1101 or C1101 (got "${flag("--d4", "")}").`);

  const [roster] = await sql`select "id", "name" from roster where "id" = ${d4} and deleted_at is null`;
  if (!roster) console.log(`\n  NOTE  4D ${d4} is not on the roster. Issuing anyway.`);
  else if (roster.name && roster.name.toUpperCase() !== person.toUpperCase())
    console.log(`\n  NOTE  roster has 4D ${d4} as "${roster.name}" — issuing as "${person}".`);

  for (const t of (await liveTokens(tokenD4)).filter((t) => samePerson(t, { person, d4 })))
    console.log(`\n  NOTE  ${t.person || t.token} already holds a live token on "${t.device_label || "?"}" (expires ${fmt(t.expires_at)}).`);

  printIssued([await issue({ person, d4, device: opt.device })]);
}

async function modeFromRoster({ tokenD4 }) {
  const role = flag("--role");
  const plt = flag("--plt");

  const people = await sql`
    select "id", "name", "role", "4d", extra
      from roster
     where deleted_at is null
       and coalesce("name", '') <> ''
       and (${role === null} or lower(coalesce("role", '')) = lower(${role ?? ""}))
     order by "id"`;

  // Platoon mirrors getPlt (js/helpers.js:15): an explicit plt field wins,
  // otherwise it is the first digit of the 4D — and Commanders are coy-level,
  // so they have no derived platoon at all.
  const pltOf = (r) => {
    const explicit = r.extra?.plt;
    if (explicit != null && String(explicit) !== "") return String(explicit);
    if (r.role === "Commander") return "";
    const m = String(r.id || "").match(/(\d)/);
    return m ? m[1] : "";
  };

  let candidates = people.map((r) => ({ person: r.name, d4: padD4(r.id), plt: pltOf(r), role: r.role }));
  if (plt !== null) {
    const want = String(plt);
    const before = candidates.length;
    candidates = candidates.filter((c) => c.plt === want);
    if (!candidates.length)
      console.log(`\n  NOTE  no one matched --plt ${want} (${before} matched the other filters).` +
        (role === "Commander" ? " Commanders are coy-level and carry no platoon." : ""));
  }

  console.log(`\n  Roster match: ${candidates.length} person(s)` +
    `${role ? ` with role "${role}"` : ""}${plt !== null ? ` in plt ${plt}` : ""}.`);
  if (!candidates.length) return;

  const tokens = await liveTokens(tokenD4);
  const outstanding = (await allInvites()).filter((i) => inviteUsable(i));
  const skipped = [];
  const todo = [];
  for (const c of candidates) {
    const tok = tokens.find((t) => samePerson(t, c));
    if (tok) { skipped.push({ ...c, why: `holds a live token on "${tok.device_label || "?"}" until ${fmt(tok.expires_at)}` }); continue; }
    const inv = outstanding.find((i) => samePerson(i, c));
    if (inv && !opt.reissue) { skipped.push({ ...c, why: `already has an open invite (expires ${fmt(inv.expires_at)}) — --reissue to override` }); continue; }
    todo.push(c);
  }

  if (skipped.length) {
    console.log(`\n  Skipping ${skipped.length}, already set up:`);
    const w = Math.max(4, ...skipped.map((s) => s.person.length));
    for (const s of skipped) console.log(`    ${pad(s.person, w)}  ${s.d4}  ${s.why}`);
  }
  if (!todo.length) { console.log("\n  Nothing to issue — everyone matched is already set up.\n"); return; }

  const issued = [];
  for (const c of todo) issued.push(await issue({ person: c.person, d4: c.d4, device: opt.device }));
  printIssued(issued);
}

async function modeList({ tokenD4 }) {
  const invites = await allInvites();
  const tokens = await liveTokens(tokenD4);
  const now = new Date();

  if (opt.json) {
    // Machine-readable and NOTHING else on stdout — no mode banner, no warning
    // — so the output pipes straight into jq or a clipboard.
    console.log(JSON.stringify({
      generatedAt: now.toISOString(),
      baseUrl: opt.baseUrl,
      invites: invites.map((i) => ({
        token: i.token,
        person: i.person,
        d4: i.d4,
        deviceLabel: i.device_label,
        status: inviteStatus(i, now),
        usable: inviteUsable(i, now),
        usesRemaining: Math.max(0, Number(i.max_uses) - Number(i.used_count)),
        maxUses: Number(i.max_uses),
        usedCount: Number(i.used_count),
        createdAt: i.created_at,
        expiresAt: i.expires_at,
        revokedAt: i.revoked_at,
        redemptions: i.redemptions,
        url: link(i.token),
      })),
      liveTokens: tokens.map((t) => ({
        token: t.token,
        person: t.person,
        d4: t.d4,
        deviceLabel: t.device_label,
        issuedAt: t.issued_at,
        lastSeenAt: t.last_seen_at,
        expiresAt: t.expires_at,
      })),
    }, null, 2));
    return;
  }

  console.log(`\n  INVITES (${invites.length})\n`);
  if (!invites.length) console.log("    none\n");
  else {
    const w = Math.max(6, ...invites.map((i) => (i.person || "(unlabelled)").length));
    console.log(`    ${pad("PERSON", w)}  4D    USES  EXPIRES            STATUS    TOKEN`);
    for (const i of invites)
      console.log(
        `    ${pad(i.person || "(unlabelled)", w)}  ${pad(i.d4 || "—", 4)}  ` +
        `${pad(`${Math.max(0, i.max_uses - i.used_count)}/${i.max_uses}`, 4)}  ` +
        `${pad(fmt(i.expires_at), 17)}  ${pad(inviteStatus(i, now), 8)}  ${i.token}`
      );
  }

  console.log(`\n  LIVE TOKENS — people who currently have access (${tokens.length})\n`);
  if (!tokens.length) console.log("    none\n");
  else {
    const w = Math.max(6, ...tokens.map((t) => (t.person || "(anonymous)").length));
    console.log(`    ${pad("PERSON", w)}  4D    DEVICE      LAST SEEN          EXPIRES            TOKEN`);
    for (const t of tokens)
      console.log(
        `    ${pad(t.person || "(anonymous)", w)}  ${pad(t.d4 || "—", 4)}  ` +
        `${pad(t.device_label || "—", 10)}  ${pad(fmt(t.last_seen_at), 17)}  ` +
        `${pad(fmt(t.expires_at), 17)}  ${t.token}`
      );
    console.log("");
  }
}

async function modeRevokeToken(token) {
  const [t] = await sql`select * from auth_tokens where token = ${token}`;
  if (!t) die(`no auth token ${token}.`);
  if (t.revoked_at) { console.log(`\n  Already revoked at ${fmt(t.revoked_at)}. Nothing to do.\n`); return; }
  console.log(`\n  ${opt.commit ? "Revoking" : "WOULD revoke"} device access:`);
  console.log(`    person  ${t.person || "(anonymous)"}`);
  console.log(`    device  ${t.device_label || "—"}`);
  console.log(`    issued  ${fmt(t.issued_at)}   last seen ${fmt(t.last_seen_at)}`);
  if (opt.commit) {
    await sql`update auth_tokens set revoked_at = now() where token = ${token}`;
    console.log("\n  Revoked. That device is locked out on its next request.\n");
  } else console.log("\n  DRY RUN — nothing was written. Re-run with --commit.\n");
}

async function modeRevokeInvite(token) {
  const [i] = await sql`select * from invites where token = ${token}`;
  if (!i) die(`no invite ${token}.`);
  if (i.revoked_at) { console.log(`\n  Already revoked at ${fmt(i.revoked_at)}. Nothing to do.\n`); return; }
  const redeemed = Number(i.used_count) > 0;
  console.log(`\n  ${opt.commit ? "Killing" : "WOULD kill"} invite for ${i.person || "(unlabelled)"} ${i.d4 || ""}`);
  console.log(`    uses    ${i.used_count}/${i.max_uses}`);
  console.log(`    expires ${fmt(i.expires_at)}`);
  console.log(`    status  ${inviteStatus(i)}`);
  if (redeemed)
    console.log("\n  NOTE  this invite has already been redeemed. Killing it does NOT\n" +
                "        revoke the device it produced — use --revoke-token for that.");
  if (opt.commit) {
    // Only revoked_at moves. max_uses/used_count stay as they are so the row
    // keeps telling the truth about whether anyone ever used the invite.
    await sql`update invites set revoked_at = now() where token = ${token}`;
    console.log("\n  Invite killed: it can no longer be redeemed.\n");
  } else console.log("\n  DRY RUN — nothing was written. Re-run with --commit.\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  opt.commit = has("--commit");
  opt.json = has("--json");
  opt.baseUrl = flag("--base-url", DEFAULT_BASE_URL);
  opt.days = num("--days", 14);
  opt.uses = num("--uses", 1);
  opt.device = flag("--device", "device");
  opt.reissue = has("--reissue");

  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) die("DATABASE_URL is not set.");
  sql = postgres(DATABASE_URL, { prepare: false, max: 4 });

  try {
    const ctx = await preflight();
    // --json must emit JSON and nothing else, so the banner is suppressed there.
    if (!opt.json) console.log(opt.commit ? "\nMODE: commit" : "\nMODE: dry run (pass --commit to write)");

    const revokeToken = flag("--revoke-token");
    const revokeInvite = flag("--revoke-invite");

    if (has("--list")) await modeList(ctx);
    else if (revokeToken) await modeRevokeToken(revokeToken);
    else if (revokeInvite) await modeRevokeInvite(revokeInvite);
    else if (has("--from-roster")) await modeFromRoster(ctx);
    else if (has("--person") || has("--d4")) await modeOne(ctx);
    else {
      console.log(`
  Nothing to do. Pick a mode:

    --person "CPT Tan Wei Ming" --d4 1101 [--device phone] [--days 14] [--uses 1]
    --from-roster --role Commander [--plt 1] [--days 14] [--reissue]
    --list [--json]
    --revoke-token  <auth token>
    --revoke-invite <invite token>

  Add --commit to actually write. See the header of this file.
`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
