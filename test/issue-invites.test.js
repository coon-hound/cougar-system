// Tests for the pure logic of scripts/issue-invites.mjs — the invite issuer.
//
// An invite IS a credential: there is no password behind it, and whoever opens
// the link becomes that person in the app and in the audit log. So the two
// decisions this script makes are both security decisions, and neither is
// observable until it is too late:
//
//   * padD4 decides WHO an invite is for. The roster stores the canonical
//     digit-only 4D in "id" and the C-prefixed DISPLAY form in "4d". An invite
//     issued with "C1101" or with Sheets' unpadded "1" joins to nobody, and the
//     token it mints is labelled with a 4D no other table recognises.
//   * inviteUsable decides whether someone is ALREADY set up. Get it wrong in
//     one direction and --from-roster re-mails a live link to 283 people; wrong
//     in the other and a person who needs access is silently skipped forever.
//
// Revocation is the case worth pinning hardest. Killing an invite used to work
// by pulling max_uses down to used_count, which made a killed invite arithmet-
// ically identical to a redeemed one — the list could not tell "nobody ever
// used this, I cancelled it" from "someone redeemed this and now holds a
// device". `revoked_at` splits them, and inviteStatus reports four distinct
// states. The tests below fix that distinction in place.
const path = require("path");
const { pathToFileURL } = require("url");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = pathToFileURL(path.join(ROOT, "scripts/issue-invites.mjs")).href;

// The script is ESM (it is a script, not app code), so it loads through
// import(). It must not run its driver on import — that is what the
// `import.meta.url === argv[1]` guard at the bottom of the file is for. If that
// guard ever breaks, this import tries to open a database connection and the
// whole suite hangs or dies here rather than mysteriously later.
let mod;
async function load() {
  if (!mod) mod = await import(SCRIPT);
  return mod;
}

const NOW = new Date("2026-09-14T12:00:00Z");
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);
const DAY = 86400000;

// A usable invite: not revoked, one use left, expires tomorrow. Every case
// below is this row with exactly one thing changed, so a failure names the one
// property that decided it.
const openInvite = (over = {}) => ({
  token: "inv-1",
  person: "CPT Tan Wei Ming",
  d4: "1101",
  max_uses: 1,
  used_count: 0,
  expires_at: at(DAY),
  revoked_at: null,
  ...over,
});

module.exports = async function run() {
  const { padD4, inviteUsable, inviteStatus } = await load();

  suite("issue-invites — padD4 (mirrors js/state.js:305)");

  await test("strips a leading C, upper or lower case", () => {
    eq(padD4("C1101"), "1101");
    eq(padD4("c1101"), "1101");
  });

  await test("left-pads 1-3 digit values to four — the commander case", () => {
    eq(padD4("1"), "0001");
    eq(padD4("12"), "0012");
    eq(padD4("123"), "0123");
    eq(padD4("C1"), "0001", "a C-prefixed short id is stripped THEN padded");
  });

  await test("leaves a canonical 4D alone and trims stray whitespace", () => {
    eq(padD4("1101"), "1101");
    eq(padD4("  1101 "), "1101");
    eq(padD4("0001"), "0001");
  });

  await test("accepts the number Sheets hands back, not just the string", () => {
    // getValues() returns 1101 as a NUMBER; an unstringified value here would
    // throw on .trim() and take the whole bulk run down mid-issue.
    eq(padD4(1101), "1101");
    eq(padD4(1), "0001");
  });

  await test("null / undefined / empty collapse to empty, never to '0000'", () => {
    // "0000" would be a real-looking 4D belonging to nobody — far worse than
    // an empty string, which the caller's /^\d{4}$/ check rejects outright.
    eq(padD4(null), "");
    eq(padD4(undefined), "");
    eq(padD4(""), "");
    eq(padD4("   "), "");
  });

  await test("a non-numeric value passes through untouched rather than being mangled", () => {
    eq(padD4("ABC"), "ABC");
    eq(padD4("11011"), "11011", "5 digits is not padded and not truncated");
  });

  suite("issue-invites — inviteUsable");

  await test("an open invite is usable", () => {
    ok(inviteUsable(openInvite(), NOW));
  });

  await test("a revoked invite is not usable even with uses left and time left", () => {
    ok(!inviteUsable(openInvite({ revoked_at: at(-DAY) }), NOW));
  });

  await test("a fully redeemed invite is not usable", () => {
    ok(!inviteUsable(openInvite({ used_count: 1, max_uses: 1 }), NOW));
    ok(!inviteUsable(openInvite({ used_count: 3, max_uses: 2 }), NOW), "over-redeemed counts too");
  });

  await test("a multi-use invite stays usable until its uses run out", () => {
    ok(inviteUsable(openInvite({ max_uses: 3, used_count: 2 }), NOW));
    ok(!inviteUsable(openInvite({ max_uses: 3, used_count: 3 }), NOW));
  });

  await test("an expired invite is not usable, and expiry is exclusive at the boundary", () => {
    ok(!inviteUsable(openInvite({ expires_at: at(-1) }), NOW));
    ok(!inviteUsable(openInvite({ expires_at: NOW }), NOW), "expires_at == now is already dead");
    ok(inviteUsable(openInvite({ expires_at: at(1) }), NOW));
  });

  await test("a null expiry means no expiry, not instant expiry", () => {
    ok(inviteUsable(openInvite({ expires_at: null }), NOW));
  });

  await test("counts arriving as text from postgres compare numerically", () => {
    // A string compare would read "10" < "9" and hand out an eleventh use.
    ok(!inviteUsable(openInvite({ max_uses: "9", used_count: "10" }), NOW));
    ok(inviteUsable(openInvite({ max_uses: "10", used_count: "9" }), NOW));
  });

  await test("timestamps arriving as ISO strings are compared as dates", () => {
    ok(inviteUsable(openInvite({ expires_at: at(DAY).toISOString() }), NOW));
    ok(!inviteUsable(openInvite({ expires_at: at(-DAY).toISOString() }), NOW));
  });

  await test("a missing invite is not usable — no invite is not a free pass", () => {
    ok(!inviteUsable(null, NOW));
    ok(!inviteUsable(undefined, NOW));
  });

  suite("issue-invites — inviteStatus (four distinct states)");

  await test("open", () => eq(inviteStatus(openInvite(), NOW), "open"));

  await test("redeemed", () =>
    eq(inviteStatus(openInvite({ used_count: 1 }), NOW), "redeemed"));

  await test("expired", () =>
    eq(inviteStatus(openInvite({ expires_at: at(-DAY) }), NOW), "expired"));

  await test("revoked", () =>
    eq(inviteStatus(openInvite({ revoked_at: at(-1) }), NOW), "revoked"));

  await test("a revoked invite reads 'revoked', not 'redeemed' — the whole point of revoked_at", () => {
    // The old scheme killed an invite by setting max_uses = used_count, which
    // made this row indistinguishable from one somebody had actually used.
    const killedUnused = openInvite({ revoked_at: at(-1), used_count: 0, max_uses: 1 });
    eq(inviteStatus(killedUnused, NOW), "revoked");
    eq(inviteStatus(openInvite({ used_count: 1, max_uses: 1 }), NOW), "redeemed");
  });

  await test("revocation outranks redemption and expiry when several apply", () => {
    eq(inviteStatus(openInvite({ revoked_at: at(-1), used_count: 1, expires_at: at(-DAY) }), NOW), "revoked");
    eq(inviteStatus(openInvite({ used_count: 1, expires_at: at(-DAY) }), NOW), "redeemed",
      "a used-up invite reads redeemed even after it would also have expired");
  });

  await test("'open' and 'usable' are the same claim — they can never disagree", () => {
    // Two answers to one question is how a person gets skipped by the bulk
    // issuer while the list swears their invite is still open.
    const cases = [
      openInvite(),
      openInvite({ revoked_at: at(-1) }),
      openInvite({ used_count: 1 }),
      openInvite({ expires_at: at(-DAY) }),
      openInvite({ expires_at: null }),
      openInvite({ max_uses: 3, used_count: 2 }),
      openInvite({ revoked_at: at(-1), used_count: 1, expires_at: at(-DAY) }),
    ];
    for (const c of cases)
      eq(inviteStatus(c, NOW) === "open", inviteUsable(c, NOW),
        `status ${inviteStatus(c, NOW)} vs usable ${inviteUsable(c, NOW)}`);
  });

  await test("status defaults to the real clock when no 'now' is passed", () => {
    ok(inviteStatus({ max_uses: 1, used_count: 0, expires_at: new Date(Date.now() + DAY), revoked_at: null }) === "open");
    ok(inviteStatus({ max_uses: 1, used_count: 0, expires_at: new Date(Date.now() - DAY), revoked_at: null }) === "expired");
  });
};
