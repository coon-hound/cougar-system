#!/usr/bin/env node
// ============================================================================
// Build a one-page document of every outstanding invite link.
//
//   DATABASE_URL=... node scripts/invite-doc.mjs [--out ~/cougar-invites.html]
//
// Why this exists: the links are credentials, and a credential that lives in a
// chat scrollback or a timestamped file in Downloads is a credential you will
// lose. This writes ONE file at ONE stable path, generated from the database,
// so it is always current and losing it costs nothing — you just run this again.
//
// It lists only invites that can still be redeemed. Revoke someone and they
// drop out of the document on the next run; add someone and they appear. There
// is no separate list to keep in step.
//
// The file is written 0600 and is NOT a web page to share. Every link in it
// grants access under that person's name, permanently, in the audit trail.
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = argOf("--out", path.join(os.homedir(), "cougar-invites.html"))
  .replace(/^~/, os.homedir());
const BASE = argOf("--base-url", "https://coon-hound.github.io/cougar-system/");

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error("Missing env: DATABASE_URL");
  console.error("  set -a; . ~/.cougar-migrate.env; set +a");
  process.exit(1);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The page is a real file next to this one, not an embedded string. Embedding
// it meant escaping backticks and ${...} inside a template literal, and the
// page's own script uses both — the first attempt produced a page that threw
// SyntaxError on load. A file has no escaping rules to get wrong.
const TEMPLATE = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "invite-doc.template.html"),
  "utf8");

const { default: postgres } = await import("postgres");
const sql = postgres(DATABASE_URL, { prepare: false, max: 2 });

try {
  // Only invites that can actually still be redeemed. Revoked, used-up and
  // expired ones are deliberately absent: a document listing dead links is
  // worse than no document, because you cannot tell which is which.
  const rows = await sql`
    select i.person, i.d4, i.token, i.expires_at,
           r.name as roster_name, r.role
      from invites i
      left join roster r on r."id" = i.d4 and r.deleted_at is null
     where i.person is not null
       and i.revoked_at is null
       and i.used_count < i.max_uses
       and (i.expires_at is null or i.expires_at > now())
     order by i.d4`;

  if (!rows.length) {
    console.log("No outstanding invites. Nothing to write.");
    console.log("Issue some:  node scripts/issue-invites.mjs --from-roster --role Commander --commit");
    process.exit(0);
  }

  const expiries = rows.map((r) => r.expires_at).filter(Boolean).sort();
  const expiry = expiries.length ? new Date(expiries[0]).toISOString().slice(0, 10) : null;
  const days = expiry
    ? Math.round((new Date(expiry) - new Date()) / 86400000)
    : null;

  // A person whose roster row has gone is a live link for someone who has left.
  const orphans = rows.filter((r) => !r.roster_name);

  const trs = rows.map((r, n) => {
    const url = `${BASE}?token=${r.token}`;
    const gone = !r.roster_name
      ? ' <span class="gone" title="not on the current roster">off roster</span>' : "";
    return `<tr><td class="n">${n + 1}</td>` +
      `<td class="nm">${esc(r.person)}${gone}</td>` +
      `<td class="d4">${esc(r.d4 || "—")}</td>` +
      `<td class="lk"><input readonly value="${esc(url)}" aria-label="Invite link for ${esc(r.person)}">` +
      `<button type="button" data-url="${esc(url)}">Copy</button></td>` +
      `<td class="st"><label><input type="checkbox" data-k="${esc(r.d4 || r.token.slice(0, 8))}"> sent</label></td></tr>`;
  }).join("\n");

  const html = TEMPLATE
    .replace(/\{\{ROWS\}\}/g, trs)
    .replace(/\{\{COUNT\}\}/g, String(rows.length))
    .replace(/\{\{EXPIRY\}\}/g, expiry ?? "no expiry")
    .replace(/\{\{DAYS\}\}/g, days === null ? "" : `(${days} day${days === 1 ? "" : "s"} left)`)
    .replace(/\{\{GENERATED\}\}/g, new Date().toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" }))
    .replace(/\{\{BASE\}\}/g, esc(BASE));

  fs.writeFileSync(OUT, html, { mode: 0o600 });
  fs.chmodSync(OUT, 0o600);

  console.log(`${rows.length} outstanding invite(s) → ${OUT}`);
  if (expiry) console.log(`  earliest expiry ${expiry}${days !== null ? ` (${days} days)` : ""}`);
  if (orphans.length) {
    console.log(`\n  ${orphans.length} live invite(s) for people NOT on the current roster:`);
    for (const o of orphans) console.log(`    ${o.d4}  ${o.person}`);
    console.log("  Revoke them:  node scripts/issue-invites.mjs --revoke-invite <token> --commit");
  }
  console.log(`\n  Open it:  open ${OUT}`);
} catch (e) {
  console.error("Failed:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
