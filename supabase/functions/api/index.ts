// ============================================================================
// Cougar data API — Supabase Edge Function
//
// Speaks the EXACT protocol the Apps Script backend spoke, so js/api.js and
// js/sync.js keep working unchanged. The contract that must not drift:
//
//   * ALWAYS HTTP 200 with a JSON body. _fetchJson (js/api.js:32-46) never
//     inspects res.ok — a non-2xx carrying JSON is treated as SUCCESS, and a
//     non-JSON body becomes a NetError that the client silently retries.
//     Errors are body fields: {error, code:401} / {error, code:503} /
//     {conflict:true, tab, serverRev}.
//   * Every response carries `build`.
//   * Field names are load-bearing: sync.js branches on res.rev, res.conflict,
//     res.serverRev, res.code, res.ok, res.failed, res.results — and on the
//     literal string res.error === "Invalid request" (js/sync.js:571), which is
//     its probe for a backend too old to understand applyOps. Returning that
//     string for anything else would silently disable batching for the session.
//
// What is deliberately BETTER than the Sheets backend (all server-side, no
// frontend change): partial upserts no longer blank unsent columns; full-tab
// writes no longer derive headers from row 0 alone; one rev bump per request;
// no global lock; every mutation audited.
// ============================================================================

import postgres from "npm:postgres@3.4.4";

const BUILD = "2026-09-03-1";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false,
  idle_timeout: 20,
  max: 5,
});

// Column-encryption key (0002_security.sql). Held in the function environment
// and passed per query — never stored in the database, so a dump alone does
// not decrypt.
const ENC_KEY = Deno.env.get("COUGAR_ENC_KEY")!;

// Apps Script keeps Gmail sending, the Claude vision proxy and the Telegram
// bot (plan §5); those three actions proxy straight through so their contract,
// including remainingQuota, is unchanged.
const APPS_SCRIPT_URL = Deno.env.get("APPS_SCRIPT_URL") ?? "";

// ── Tab metadata ────────────────────────────────────────────────────────────

// Sheet tab → Postgres table.
const TABLE: Record<string, string> = {
  Roster: "roster", Medical: "medical", Attendance: "attendance",
  IPPT: "ippt", RouteMarch: "routemarch", SOC: "soc",
  PolarFlow: "polarflow", ConductDetail: "conductdetail",
  Appointments: "appointments", Leave: "leave", MSK: "msk",
  Conducts: "conducts", ParadeStates: "paradestates",
  TgUsers: "tgusers", ReportSick: "reportsick", Config: "config",
  Duty: "duty", Calendar: "calendar", OilRules: "oil_rule",
};

// Sheet tab → readAll response key (mirrors TAB_TO_STATE, js/state.js:32-45).
// Note rm/polar/conductDetail do NOT match their tab names.
const STATE_KEY: Record<string, string> = {
  Roster: "roster", Medical: "medical", Attendance: "attendance",
  IPPT: "ippt", RouteMarch: "rm", SOC: "soc", PolarFlow: "polar",
  ConductDetail: "conductDetail", Appointments: "appointments",
  Leave: "leave", MSK: "msk", Conducts: "conducts",
  // The duty schedule (0009). `calendar` is the per-DATE context (PH, IPPT,
  // NDP ...) and `oil_rule` the off-in-lieu entitlement rules; absence stays
  // in Leave and Medical, so there is no tab for it here.
  Duty: "duty", Calendar: "calendar", OilRules: "oilRule",
};

// Exactly REV_TABS (apps-script-Code.gs:309-310). ParadeStates, TgUsers,
// ReportSick and Config are deliberately untracked, as they were before.
const REV_TABS = Object.keys(STATE_KEY);

// Encrypted at rest (0002). Roster only.
const ENCRYPTED = new Set([
  "dob", "bloodType", "allergies", "otherMedical",
  "address", "nokName", "nokRelation", "nokPhone",
]);

// Tabs with no `id` column, so id-based ops are meaningless and a full-tab
// replace is the only write path:
//   MSK    — no `id` in the sheet and none in normalizeMSK (js/state.js:397-417)
//   Config — a single settings row keyed by _pk
// Neither holds encrypted columns, which appendOne relies on.
const NO_ID = new Set(["MSK", "Config"]);

// Tabs only an admin may WRITE. Everyone reads them - a commander has to see
// the roster he is on - but building it is the company admin's job.
//
// This is the protection, not the hidden nav button. js/* is public code, so a
// commander can unhide any control or call the action straight from a console;
// the UI gate only spares 25 people a button that would tell them no. The
// capability is `can_invite`, deliberately: in this company the person who
// hands out access is the person who builds the roster, and a second flag
// nobody has a way to grant is a permission that exists only on paper. If the
// two ever need to part company, give auth_tokens its own column and read it
// here - every call site is this one line.
const ADMIN_WRITE_TABS = new Set(["Duty", "Calendar", "OilRules"]);

let DENIED: Record<string, Set<string>> | null = null;
async function deniedFields(tab: string): Promise<Set<string>> {
  if (!DENIED) {
    const rows = await sql`select tab, field from dropped_fields`;
    DENIED = {};
    for (const r of rows) (DENIED[r.tab] ??= new Set()).add(r.field);
  }
  return DENIED[tab] ?? new Set();
}

// ── Response plumbing ───────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// Always 200 — see the header comment. Never change this to res.status.
function json(obj: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ...obj, build: BUILD }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const unauthorized = () => json({ error: "Unauthorized — invite required", code: 401 });

// Canonicalise a 4D exactly as padD4 does (js/state.js:284): strip a leading
// "C", then left-pad 1-3 digit values to 4 so commander "1" becomes "0001".
function padD4(v: unknown): string {
  const s = String(v ?? "").trim().replace(/^C/i, "");
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
}

// ── Row shaping ─────────────────────────────────────────────────────────────

// Split an incoming row into real columns vs `extra`, dropping deny-listed
// fields. Without the deny-list, dropped fields would just reaccumulate in
// `extra` on the next full-tab write.
async function shapeRow(tab: string, table: string, row: Record<string, unknown>) {
  const cols = await columnsOf(table);
  const denied = await deniedFields(tab);
  const real: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(row)) {
    if (k === "auth" || denied.has(k)) continue;
    if (cols.has(k)) real[k] = v;
    else extra[k] = v;
  }
  // Roster's primary key is the canonical digit-only 4D. Live data keeps the
  // C-prefixed display form in "4d" and the canonical form in "id"; 26 of 282
  // rows (all Commanders) carry only "4d", so derive defensively.
  if (tab === "Roster") real["id"] = padD4(real["id"] || real["4d"] || "");
  return { real, extra };
}

const COLCACHE: Record<string, Set<string>> = {};
async function columnsOf(table: string): Promise<Set<string>> {
  if (!COLCACHE[table]) {
    const rows = await sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = ${table}`;
    COLCACHE[table] = new Set(
      rows.map((r) => r.column_name as string)
        .filter((c) => !["extra", "updated_at", "deleted_at", "_pk"].includes(c)),
    );
  }
  return COLCACHE[table];
}

// Build the SELECT list. Roster goes through roster_api_row() so the encrypted
// columns come back decrypted; everything else uses api_row().
function selectRows(table: string) {
  return table === "roster"
    ? sql`select roster_api_row(t, ${ENC_KEY}) as row from roster t where t.deleted_at is null`
    : sql`select api_row(to_jsonb(t)) as row from ${sql(table)} t where t.deleted_at is null`;
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function allRevs(): Promise<Record<string, number>> {
  const rows = await sql`select tab, rev from revs`;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.tab] = Number(r.rev);
  return out;
}

async function readAll() {
  const out: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    sheetName: "cougar",
  };
  // 12 small tables; parallel round trips keep this well under a second
  // against the 10-60s the Apps Script readAll used to cost.
  const results = await Promise.all(
    REV_TABS.map(async (tab) => [tab, (await selectRows(TABLE[tab])).map((r) => r.row)] as const),
  );
  for (const [tab, rows] of results) out[STATE_KEY[tab]] = rows;
  out.revs = await allRevs();
  return json(out);
}

async function readTab(tab: string) {
  const table = TABLE[tab];
  if (!table) return json({ error: `Tab '${tab}' not found` });
  const rows = (await selectRows(table)).map((r) => r.row);
  const revs = await allRevs();
  // read&tab returns {rows, rev}; js/api.js:117 also tolerates a bare array.
  return json({ rows, rev: revs[tab] ?? null });
}

// ── Writes ──────────────────────────────────────────────────────────────────

// Wraps a mutation in one transaction that also owns the revision bump.
//
// `enforce` is TRUE ONLY for full-tab `write`. Row-scoped ops deliberately run
// with enforce=false — apps-script-Code.gs:212-216 records that enforcing them
// produced false conflicts and a retry storm, and js/sync.js is built around
// last-write-wins for same-row edits.
async function withRev<T>(
  tab: string,
  baseRev: unknown,
  enforce: boolean,
  fn: (tx: postgres.TransactionSql) => Promise<T | { error: string }>,
): Promise<Record<string, unknown>> {
  const tracked = REV_TABS.includes(tab);
  try {
    return await sql.begin(async (tx) => {
      let serverRev: number | null = null;
      if (tracked) {
        const [r] = await tx`select rev from revs where tab = ${tab} for update`;
        serverRev = r ? Number(r.rev) : null;
        if (enforce && baseRev != null && Number(baseRev) !== serverRev) {
          return { conflict: true, tab, serverRev };
        }
      }
      const result = await fn(tx);
      // Match Apps Script: a failed op does not bump (:373).
      if (result && typeof result === "object" && "error" in result) {
        return result as Record<string, unknown>;
      }
      // Nor does an op that changed nothing. A replayed append (or a delete of
      // an already-gone row) answers "noop"; bumping there would wake every
      // other device for a pull that finds no change — pure churn, and churn
      // is half of what made the old backend feel slow.
      const noChange = result && typeof result === "object" &&
        (result as Record<string, unknown>).action === "noop";
      let rev: number | undefined;
      if (tracked && !noChange) {
        const [b] = await tx`
          insert into revs (tab, rev) values (${tab}, 2)
          on conflict (tab) do update set rev = revs.rev + 1
          returning rev`;
        rev = Number(b.rev);
      } else if (tracked) {
        rev = serverRev ?? undefined;
      }
      return { ok: true, tab, ...(result as object), ...(rev != null ? { rev } : {}) };
    }) as Record<string, unknown>;
  } catch (e) {
    // A lock timeout or serialization failure is the analogue of the old
    // "Server busy" path, which sync.js retries in place up to 4 times.
    const msg = String((e as Error)?.message ?? e);
    if (/lock|deadlock|serial|timeout/i.test(msg)) return { error: "Server busy, please retry", code: 503 };
    return { error: msg };
  }
}

// Coerce to the text the Sheets backend would have produced; null stays null.
const str = (v: unknown) => (v == null ? null : String(v));

// One SET fragment per provided column, encrypting where required. Both the
// insert and update paths go through this, so encryption cannot be forgotten
// on one of them.
function setFragments(tx: postgres.Sql, real: Record<string, unknown>): Frag[] {
  return Object.keys(real).map((k): Frag =>
    ENCRYPTED.has(k)
      ? tx`${tx(k)} = enc_col(${str(real[k])}, ${ENC_KEY})`
      : tx`${tx(k)} = ${str(real[k])}`
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frag = any;   // postgres.js template fragment; see note above
const joinFrags = (tx: postgres.Sql, frags: Frag[]): Frag =>
  frags.reduce((a: Frag, b: Frag) => tx`${a}, ${b}`);

// Upsert keyed on `id`, updating ONLY the columns present in the payload.
//
// This is the single most important behavioural fix in the migration. The old
// upsertRow (apps-script-Code.gs:1105-1108) rebuilt the row from every current
// header and wrote "" for anything the client had not sent, so a device with a
// stale model silently erased campIn / groups / location / program on save.
//
// Insert-then-update rather than a values list: it keeps one encryption path
// for both branches, and the data is small enough that the extra round trip is
// irrelevant next to the 10-60s Apps Script cold start it replaces.
async function upsertOne(tx: postgres.TransactionSql, tab: string, row: Record<string, unknown>) {
  const table = TABLE[tab];
  // No `id` column means no row identity, so an id-keyed op is meaningless.
  // The Sheets backend refused these too (upsertRow / deleteRowById both bail
  // with "No 'id' column in tab X" once indexOf("id") is -1,
  // apps-script-Code.gs:1113/958). Same wording, so a user staring at the sync
  // banner sees what they saw before — and so a raw Postgres
  // 'column "id" does not exist' never reaches the UI.
  if (NO_ID.has(tab)) return { error: `No 'id' column in tab ${tab}` };
  const { real, extra } = await shapeRow(tab, table, row);
  const id = str(real["id"]);
  if (!id) return { error: `Row for '${tab}' has no id` };

  // Capture the row as it stands so the audit log can record what changed, not
  // merely that something did.
  //
  // NOTE the encrypted columns are deliberately NOT read back here. Two
  // reasons, and the second is the one that matters: pgp_sym_encrypt uses a
  // random IV, so the same value re-encrypted is different bytes and would
  // register as a change on every write; and decrypting them into this function
  // just to hand them to the audit log would put plaintext dates of birth and
  // next-of-kin details on a path that exists to be kept for two years.
  // log_audit redacts as a second line of defence, but the values are not sent
  // in the first place.
  const [existing] = await tx`
    select api_row(to_jsonb(t)) as row from ${tx(table)} t where t."id" = ${id}`;
  const before = existing ? (existing.row as Record<string, unknown>) : null;
  if (!existing) await tx`insert into ${tx(table)} ("id") values (${id})`;

  await tx`
    update ${tx(table)}
       set ${joinFrags(tx, setFragments(tx, real))},
           extra = extra || ${tx.json(extra as postgres.JSONValue)},
           deleted_at = null
     where "id" = ${id}`;

  const after: Record<string, unknown> = { ...(before ?? {}) };
  for (const [k, v] of Object.entries(real)) if (!ENCRYPTED.has(k)) after[k] = str(v);
  const touchedSensitive = Object.keys(real).filter((k) => ENCRYPTED.has(k));

  return {
    action: existing ? "updated" : "appended",
    id,
    _audit: { before, after, touchedSensitive },
  };
}

// Append, idempotent on id — a retried append after a lost response must not
// create a second copy (apps-script-Code.gs:1005-1008).
async function appendOne(tx: postgres.TransactionSql, tab: string, row: Record<string, unknown>) {
  const table = TABLE[tab];

  // MSK and Config carry no `id` and no encrypted columns, so a plain object
  // insert is both sufficient and safe for them.
  if (NO_ID.has(tab)) {
    const { real, extra } = await shapeRow(tab, table, row);
    const plain: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(real)) plain[k] = str(v);

    // Config is a single row pinned to _pk = 1 by a check constraint, so an
    // append is an update of that row. The Sheets version literally appended a
    // second Config row, which getConfig (apps-script-Code.gs:1589) then
    // ignored because it reads rows[0] — so the settings write was silently
    // lost. Writing the one row is the same outcome the caller wanted, minus
    // the dead row and minus a duplicate-key error.
    if (tab === "Config") {
      await tx`insert into config (_pk) values (1) on conflict (_pk) do nothing`;
      if (Object.keys(plain).length) {
        await tx`update config set ${joinFrags(tx, setFragments(tx, plain))} where _pk = 1`;
      }
      if (Object.keys(extra).length) {
        await tx`update config set extra = extra || ${tx.json(extra as postgres.JSONValue)} where _pk = 1`;
      }
      return { action: "updated" };
    }

    const [ins] = await tx`insert into ${tx(table)} ${tx(plain)} returning _pk`;
    if (Object.keys(extra).length) {
      await tx`update ${tx(table)} set extra = extra || ${tx.json(extra as postgres.JSONValue)} where _pk = ${ins._pk}`;
    }
    return { action: "appended" };
  }

  const { real } = await shapeRow(tab, table, row);
  const id = str(real["id"]);
  if (!id) return { error: `Row for '${tab}' has no id` };
  const [dupe] = await tx`select 1 from ${tx(table)} where "id" = ${id} and deleted_at is null`;
  if (dupe) return { action: "noop", id };

  // Past the dupe check there is no LIVE row with this id, so whatever upsert
  // does underneath, the client is watching a row come into existence: report
  // "appended". Deletes here are soft, so a delete-then-append of the same id
  // revives the tombstone and upsert would call that an "update" — a
  // distinction that exists only because of how this backend stores deletes,
  // and one the Sheets backend could not have made, having really removed the
  // row. Reviving is the right data outcome; "updated" would be the wrong word
  // for it.
  const r = await upsertOne(tx, tab, row);
  return "error" in r ? r : { ...r, action: "appended" };
}

async function deleteOne(tx: postgres.TransactionSql, tab: string, id: unknown) {
  const table = TABLE[tab];
  if (NO_ID.has(tab)) return { error: `No 'id' column in tab ${tab}` };
  const key = str(id);
  if (!key) return { action: "noop" };
  const [prior] = await tx`
    select api_row(to_jsonb(t)) as row from ${tx(table)} t
     where t."id" = ${key} and t.deleted_at is null`;
  const rows = await tx`
    update ${tx(table)} set deleted_at = now()
     where "id" = ${key} and deleted_at is null
     returning "id"`;
  return {
    action: rows.length ? "deleted" : "noop",
    id: key,
    // after is null: the row is gone. before is what it said, so a delete can
    // be read back and undone.
    _audit: rows.length ? { before: prior?.row ?? null, after: null } : undefined,
  };
}

// Full-tab replace. The old writeTab (apps-script-Code.gs:842-844) cleared the
// sheet and rebuilt headers from data[0] ALONE, so any key missing from the
// first row was dropped for the whole tab and a mid-write failure left it
// blank. Here it is a transactional diff: upsert everything present, soft
// delete what is absent, and never destroy a column.
async function writeWholeTab(tx: postgres.TransactionSql, tab: string, data: Record<string, unknown>[]) {
  const table = TABLE[tab];

  if (NO_ID.has(tab)) {
    await tx`delete from ${tx(table)}`;
    for (const row of data) await appendOne(tx, tab, row);
    return { rowsWritten: data.length, timestamp: new Date().toISOString() };
  }

  const seen: string[] = [];
  for (const row of data) {
    const r = await upsertOne(tx, tab, row);
    if ("error" in r) return r;
    seen.push(String(r.id));
  }
  // NOTE: an empty `data` soft-deletes the whole tab. That matches the old
  // writeTab, which cleared the sheet first — and js/sync.js only ever sends a
  // full STATE array here — but it is the one shape of this request that can
  // erase a tab, which is why `write` is the only OCC-enforced action.
  await tx`
    update ${tx(table)} set deleted_at = now()
     where deleted_at is null and not ("id" = any(${seen}))`;
  return { rowsWritten: data.length, timestamp: new Date().toISOString() };
}

// applyOps — ordered, one transaction, ONE rev bump, and partial success:
// a single bad op must not abort the rest, so each runs in a savepoint.
async function applyOps(tx: postgres.TransactionSql, tab: string, ops: Record<string, unknown>[]) {
  const results: Record<string, unknown>[] = [];
  let applied = 0, failed = 0;

  for (const op of ops) {
    try {
      const r = await tx.savepoint(async (sp: postgres.TransactionSql) => {
        switch (op.op) {
          case "upsert": return await upsertOne(sp, tab, op.row as Record<string, unknown>);
          case "append": return await appendOne(sp, tab, op.row as Record<string, unknown>);
          case "delete": return await deleteOne(sp, tab, op.id);
          default: return { error: `Unknown op '${op.op}'` };
        }
      }) as Record<string, unknown>;
      // _audit is internal: it carries row contents, and the client has no
      // business receiving them back in a write response.
      if (r && typeof r === "object" && "_audit" in r) delete (r as Record<string, unknown>)._audit;
      if (r && "error" in r) { failed++; results.push(r); }
      else { applied++; results.push(r); }
    } catch (e) {
      failed++;
      results.push({ error: String((e as Error)?.message ?? e) });
    }
  }
  return { applied, failed, results };
}

// ── Usage telemetry (0005_usage.sql) ────────────────────────────────────────
//
// Two actions that deliberately DO NOT go through withRev, TABLE, shapeRow or
// log_audit. usage_daily is not a tab: it is not in REV_TABS, not in readAll,
// and not in the pull cycle, so nothing written here bumps a revision or wakes
// another device. See the header of 0005_usage.sql and TELEMETRY-DESIGN.md.
//
// The audit log is skipped on purpose too. It exists to answer "who changed
// this person's record"; a counter increment is not that, and at flush volume
// it would bury the rows that matter.

const USAGE_KINDS = new Set(["feature", "view", "task"]);
const MAX_USAGE_ROWS = 500;
const MAX_COUNTER = 1_000_000;

// Second line of defence on the name, mirroring scrubName + isSafeName in
// js/telemetry.js, and applied again here because the client is public code and
// a hand-crafted request is not a hypothetical.
//
// Two rules. Any run of two or more digits is stripped, because a 4D is four
// digits and no handler name in the frontend contains one. Then the result must
// be a single identifier-shaped token: every legitimate descriptor
// ("submitBookOut", "nav:roster", "button.btn#pull-btn", "book_out") is one,
// and prose — which is what a name or a free-text reason looks like — is not.
// Stripping digits defeats a 4D but not a NAME, so the allow-list is what
// actually holds the line.
function scrubUsageName(v: unknown): string {
  const s = String(v ?? "")
    .replace(/\d{2,}/g, "")
    .replace(/[^\w:.#$ /-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return /^[\w:.#$/-]+$/.test(s) ? s : "";
}

const counter = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_COUNTER) : 0;
};

type UsageRow = {
  day: string; device: string; kind: string; name: string;
  events: number; completed: number; abandoned: number; clicks: number; ms: number;
};

// Append one batch of counter DELTAS. Additive, so it needs replay protection:
// the batch id is inserted first and a redelivered batch conflicts there and
// short-circuits before any counter moves. That matters because the client
// flushes with navigator.sendBeacon on page-hide, where the response is never
// seen and a retry is the only safe assumption.
async function usageAppend(body: Record<string, unknown>) {
  const device = String(body.device ?? "").trim();
  const batchId = String(body.batchId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(device)) return json({ error: "Bad device id" });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(batchId)) return json({ error: "Bad batch id" });

  const raw = Array.isArray(body.rows) ? body.rows as Record<string, unknown>[] : [];
  if (!raw.length) return json({ ok: true, rows: 0 });
  if (raw.length > MAX_USAGE_ROWS) return json({ error: `Too many rows (max ${MAX_USAGE_ROWS})` });

  // Fold duplicates inside one batch: `insert ... on conflict do update` cannot
  // touch the same target row twice in a single statement.
  const merged = new Map<string, UsageRow>();
  for (const r of raw) {
    const day = String(r.day ?? "").slice(0, 10);
    const kind = String(r.kind ?? "");
    const name = scrubUsageName(r.name);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !USAGE_KINDS.has(kind) || !name) continue;
    const key = `${day}|${kind}|${name}`;
    const cur = merged.get(key) ??
      { day, device, kind, name, events: 0, completed: 0, abandoned: 0, clicks: 0, ms: 0 };
    cur.events += counter(r.events);
    cur.completed += counter(r.completed);
    cur.abandoned += counter(r.abandoned);
    cur.clicks += counter(r.clicks);
    cur.ms += counter(r.ms);
    merged.set(key, cur);
  }
  const rows = [...merged.values()];
  if (!rows.length) return json({ ok: true, rows: 0 });

  try {
    const out = await sql.begin(async (tx) => {
      const claimed = await tx`
        insert into usage_batches (batch_id, device, rows_count)
        values (${batchId}, ${device}, ${rows.length})
        on conflict (batch_id) do nothing
        returning batch_id`;
      // Already applied. Answering ok:true lets the client clear its pending
      // delta instead of retrying forever against a batch that landed.
      if (!claimed.length) return { ok: true, duplicate: true, rows: 0 };

      await tx`
        insert into usage_daily ${
        tx(rows, "day", "device", "kind", "name", "events", "completed", "abandoned", "clicks", "ms")
      }
        on conflict (day, device, kind, name) do update set
          events    = usage_daily.events    + excluded.events,
          completed = usage_daily.completed + excluded.completed,
          abandoned = usage_daily.abandoned + excluded.abandoned,
          clicks    = usage_daily.clicks    + excluded.clicks,
          ms        = usage_daily.ms        + excluded.ms,
          updated_at = now()`;
      return { ok: true, rows: rows.length };
    }) as Record<string, unknown>;
    return json(out);
  } catch (e) {
    // A failed flush is never the user's problem: the client keeps the delta
    // and sends it with the next batch.
    return json({ error: String((e as Error)?.message ?? e) });
  }
}

// On-demand read for the insights view. Never called on launch, never part of
// a pull — only when somebody actually opens the view.
async function usageRead(body: Record<string, unknown>) {
  const scope = String(body.scope ?? "company");
  const device = String(body.device ?? "").trim();
  const days = Math.min(Math.max(Math.trunc(Number(body.days ?? 14)) || 14, 1), 180);
  if (scope === "device" && !/^[A-Za-z0-9_-]{1,32}$/.test(device)) {
    return json({ error: "Bad device id" });
  }
  try {
    // Explicit casts: a bare null parameter carries no type, and the function
    // signature is what has to resolve it.
    const rows = await sql`
      select * from usage_rollup(${days}::int, ${scope === "device" ? device : null}::text)`;
    const devices = await sql`
      select count(distinct device)::int as n from usage_daily
       where day >= current_date - ${days}::int`;
    return json({ ok: true, scope, days, devices: devices[0]?.n ?? 0, rows });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
}

// ── Apps Script passthrough ─────────────────────────────────────────────────

async function proxyToAppsScript(body: Record<string, unknown>) {
  if (!APPS_SCRIPT_URL) return json({ error: "Apps Script passthrough not configured" });
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    });
    return json(await res.json());
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────

// Accepts the Authorization header (plan §4.2) and, during cutover, the legacy
// `auth` query param / body field. The old backend put the token in GET query
// strings (js/api.js:70), where it landed in execution logs and browser
// history; the header path exists because this backend can answer OPTIONS,
// which Apps Script never could. Drop the param once every device is updated.
async function authenticate(req: Request, bodyAuth?: unknown) {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const url = new URL(req.url);
  const token = bearer || String(bodyAuth ?? url.searchParams.get("auth") ?? "");
  const [row] = await sql`select * from check_auth(${token})`;
  return { ok: !!row?.ok, person: row?.person ?? null, reason: row?.reason ?? "unknown", token };
}

// ── Access management ───────────────────────────────────────────────────────
//
// EVERY ONE OF THESE IS REFUSED UNLESS THE CALLING TOKEN HAS can_invite.
// js/* is public code served to every phone, so the screen being hidden in the
// client protects nothing — anyone can read the source and send the request by
// hand. This check is the control. The hiding is only so 25 people are not
// shown a button that would tell them no.
//
// Refusals answer the same opaque 403 whatever the reason, so the endpoint does
// not become a way to discover who is privileged.
const forbidden = () => json({ error: "Not allowed", code: 403 });

async function canInvite(token: string): Promise<boolean> {
  const [row] = await sql`
    select can_invite from auth_tokens
     where token = ${token} and revoked_at is null and expires_at > now()`;
  return !!row?.can_invite;
}

// The access list, carrying no credentials of any kind (see access_overview).
async function listAccess() {
  // `token` is populated for OPEN INVITES ONLY, and is null for everything
  // else. A deliberate narrowing of "no credentials cross the wire": an
  // unredeemed invite link is precisely what this page exists to hand out, and
  // without it the link is visible once at creation and then lost forever.
  //
  // Auth tokens are still never sent. A redeemed or revoked invite sends
  // nothing either — those links are dead, and a dead credential on screen is
  // just something to confuse somebody later.
  const rows = await sql`
    select kind, person, d4, device_label, at, expires_at, last_seen_at, status,
           can_invite, used_count, max_uses,
           case when kind = 'invite' and status = 'open' then token end as token
      from access_overview
     order by coalesce(person, 'zzz'), device_label, at desc`;
  return json({ ok: true, access: rows });
}

// Create an invite already tagged to a person. The name and 4D are taken from
// the ROSTER, not from whatever the client sent: a client-supplied name would
// let a tampered request mint a credential labelled as somebody it is not, and
// that label is what the audit trail reports for everything they then do.
async function createInvite(d4: unknown, deviceLabel: unknown, days: unknown, uses: unknown) {
  const key = padD4(d4);
  if (!key) return json({ error: "No 4D given" });

  const [person] = await sql`
    select "id", "name", "role" from roster
     where "id" = ${key} and deleted_at is null`;
  if (!person) return json({ error: `Nobody on the current roster has 4D ${key}` });

  // Scoped to (person, DEVICE), not person. Someone with a phone and a tablet
  // needs two open links at once, and blocking the second was the screen
  // refusing the exact thing it exists to do.
  //
  // A second open link for the SAME device is still refused: that is two live
  // credentials for one device with no way to tell which was used, which is
  // the one case where the block helps rather than gets in the way.
  const label = String(deviceLabel || "device");
  const [existing] = await sql`
    select token from invites
     where d4 = ${key} and device_label = ${label} and revoked_at is null
       and used_count < max_uses and (expires_at is null or expires_at > now())`;
  if (existing) {
    return json({ error: `${person.name} already has an unopened link for "${label}". Cancel it, or name this device something else.` });
  }

  const n = Math.min(Math.max(Number(days) || 14, 1), 90);
  // More than one use lets the same link cover a second device, and lets
  // someone re-join after their browser cleared its storage — which takes the
  // token with it, and is the most common way access is lost. Capped so a link
  // cannot be passed around indefinitely.
  const u = Math.min(Math.max(Number(uses) || 1, 1), 5);
  const token = crypto.randomUUID();
  await sql`
    insert into invites (token, person, d4, device_label, max_uses, expires_at)
    values (${token}, ${person.name}, ${key}, ${label},
            ${u}, now() + make_interval(days => ${n}))`;
  return json({ ok: true, token, person: person.name, d4: key, days: n, uses: u });
}

// Revoke by PERSON, never by token: the client is never given a credential, so
// it cannot be asked to hand one back. Kills the open invite, the live devices,
// or both — because "take away their access" almost always means both, and
// revoking only the link leaves a phone that is already signed in still signed in.
// "I cleared my browser and now I cannot get in."
//
// The commonest way access is lost, and until now a dead end: clearing site
// data takes localStorage with it, so the token is gone from the phone while
// the row in auth_tokens still looks perfectly active. last_seen_at quietly
// stops moving and nothing surfaces it. issue-invites.mjs --from-roster even
// SKIPS them, because they count as already set up.
//
// Both halves in one transaction, so a failure cannot leave someone revoked
// with no way back in: kill the dead token for that person and device, mint a
// fresh link for the same person and device, hand it back ready to send.
async function reissueAccess(d4: unknown, deviceLabel: unknown, days: unknown, uses: unknown) {
  const key = padD4(d4);
  if (!key) return json({ error: "No 4D given" });
  const label = String(deviceLabel || "device");

  const [person] = await sql`
    select "id", "name" from roster where "id" = ${key} and deleted_at is null`;
  if (!person) return json({ error: `Nobody on the current roster has 4D ${key}` });

  const n = Math.min(Math.max(Number(days) || 90, 1), 90);
  const u = Math.min(Math.max(Number(uses) || 3, 1), 5);
  const token = crypto.randomUUID();

  const out = await sql.begin(async (tx) => {
    // Never the owner's own token: the screen that manages everyone else's
    // access must not be able to lock its operator out of it.
    const dead = await tx`
      update auth_tokens set revoked_at = now()
       where d4 = ${key} and device_label = ${label}
         and revoked_at is null and can_invite = false
       returning token`;
    // Any unopened link for the same device is superseded by this one.
    await tx`
      update invites set revoked_at = now()
       where d4 = ${key} and device_label = ${label}
         and revoked_at is null and used_count < max_uses`;
    await tx`
      insert into invites (token, person, d4, device_label, max_uses, expires_at)
      values (${token}, ${person.name}, ${key}, ${label}, ${u},
              now() + make_interval(days => ${n}))`;
    return { replaced: dead.length };
  });

  return json({ ok: true, token, person: person.name, d4: key,
                device: label, days: n, uses: u, replaced: out.replaced });
}

async function revokeAccess(d4: unknown, what: unknown, device: unknown) {
  const key = padD4(d4);
  if (!key) return json({ error: "No 4D given" });
  const scope = String(what || "all");
  // A person may hold several tokens — a phone and a tablet are two rows, and
  // nothing in the schema stops that. `device` narrows the revoke to one of
  // them, so a lost tablet does not sign someone out of the phone in their
  // pocket. Absent, it means all of them, which is what "remove their access"
  // usually means.
  const one = device ? String(device) : null;
  let invites = 0, tokens = 0;

  if (scope === "all" || scope === "invite") {
    const r = await sql`
      update invites set revoked_at = now()
       where d4 = ${key} and revoked_at is null and used_count < max_uses
         and (${one}::text is null or device_label = ${one})
       returning token`;
    invites = r.length;
  }
  if (scope === "all" || scope === "token") {
    // can_invite tokens are excluded: the owner cannot be locked out of the
    // system by the screen that exists to manage everyone else's access.
    const r = await sql`
      update auth_tokens set revoked_at = now()
       where d4 = ${key} and revoked_at is null and can_invite = false
         and (${one}::text is null or device_label = ${one})
       returning token`;
    tokens = r.length;
  }
  return json({ ok: true, d4: key, device: one, invitesRevoked: invites, devicesRevoked: tokens });
}

async function redeemInvite(token: string) {
  return await sql.begin(async (tx) => {
    const [inv] = await tx`select * from invites where token = ${token} for update`;
    if (!inv) return { error: "Invalid invite" };
    if (inv.expires_at && new Date(inv.expires_at) <= new Date()) return { error: "Invite expired" };
    if (inv.used_count >= inv.max_uses) return { error: "Invite already used" };

    // The invite carries who it was issued to; the token inherits it. Before
    // this, `person` was set to the INVITE'S OWN TOKEN, so everyone who joined
    // by invite appeared as a raw UUID in the access list and in every audit
    // row they generated — attribution that could not name anybody.
    const authToken = crypto.randomUUID();
    await tx`
      insert into auth_tokens (token, person, d4, device_label)
      values (${authToken}, ${inv.person ?? null}, ${inv.d4 ?? null},
              ${inv.device_label ?? "device"})`;
    await tx`
      update invites
         set used_count = used_count + 1,
             redemptions = redemptions || ${tx.json([{ at: new Date().toISOString() }])}
       where token = ${token}`;
    return { ok: true, authToken };
  }) as Record<string, unknown>;
}

// ── Router ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);

  try {
    // ---- GET -------------------------------------------------------------
    if (req.method === "GET") {
      const action = url.searchParams.get("action") ?? "readAll";
      const tab = url.searchParams.get("tab") ?? "";

      // ping is the only public GET (apps-script-Code.gs:156).
      if (action === "ping") {
        return json({ ok: true, sheets: Object.keys(TABLE), timestamp: new Date().toISOString() });
      }
      const auth = await authenticate(req);
      if (!auth.ok) return unauthorized();

      if (action === "readAll") return await readAll();
      if (action === "revCheck") return json({ ok: true, revs: await allRevs(), timestamp: new Date().toISOString() });
      if (action === "read") return await readTab(tab);
      return json({ error: "Unknown action. Use: readAll, revCheck, read&tab=TabName, or ping" });
    }

    // ---- POST ------------------------------------------------------------
    if (req.method !== "POST") return json({ error: "Invalid request" });

    const body = JSON.parse(await req.text() || "{}") as Record<string, unknown>;
    const action = String(body.action ?? "write");

    if (action === "redeemInvite") return json(await redeemInvite(String(body.token ?? "")));

    const auth = await authenticate(req, body.auth);
    if (!auth.ok) return unauthorized();

    // Passthrough to Apps Script, which still owns Gmail and Claude vision.
    if (action === "sendEmail" || action === "getEmailInfo" || action === "analyzePhoto") {
      return await proxyToAppsScript(body);
    }

    // Usage telemetry carries no `tab`, so it must be dispatched BEFORE the
    // tab lookup below (which would answer "Tab '' not found"). Neither action
    // touches revs, the write queue, or the audit log — see the section above.
    if (action === "usageAppend") return await usageAppend(body);
    if (action === "usageRead") return await usageRead(body);

    // ── Identity and access management ─────────────────────────────────────
    //
    // whoami needs no capability: every client asks it on launch so it can show
    // who is signed in. The three that follow are refused without can_invite,
    // and that refusal — not the client hiding a button — is the control.
    if (action === "whoami") {
      const [me] = await sql`select * from whoami(${auth.token})`;
      return json({
        ok: true,
        person: me?.person ?? null,
        d4: me?.d4 ?? null,
        device: me?.device_label ?? null,
        canInvite: !!me?.can_invite,
        // Same flag today (see ADMIN_WRITE_TABS), but named for what the duty
        // screen asks, so the two can diverge without touching the frontend.
        canEditDuty: !!me?.can_invite,
        expiresAt: me?.expires_at ?? null,
      });
    }

    if (action === "listAccess" || action === "createInvite"
        || action === "reissueAccess" || action === "revokeAccess") {
      if (!(await canInvite(auth.token))) {
        await sql`select log_audit(${auth.token}, ${action}, null, null, false,
                                   ${sql.json({ reason: "not allowed" })})`;
        return forbidden();
      }
      let out: Response;
      if (action === "listAccess") out = await listAccess();
      else if (action === "createInvite") out = await createInvite(body.d4, body.device, body.days, body.uses);
      else if (action === "reissueAccess") out = await reissueAccess(body.d4, body.device, body.days, body.uses);
      else out = await revokeAccess(body.d4, body.what, body.device);
      // Handing out or taking away access is exactly the kind of act the audit
      // trail exists for, so it is recorded like any other mutation.
      await sql`select log_audit(${auth.token}, ${action}, null,
                                 ${String(body.d4 ?? "")}, true,
                                 ${sql.json({ what: String(body.what ?? "") })})`;
      return out;
    }

    const tab = String(body.tab ?? "");
    const table = TABLE[tab];
    if (!table && action !== "rowCount") return json({ error: `Tab '${tab}' not found` });

    if (action === "rowCount") {
      if (!table) return json({ error: `Tab '${tab}' not found` });
      const [r] = await sql`select count(*)::int as n from ${sql(table)} where deleted_at is null`;
      return json({ ok: true, tab, dataRows: r.n });
    }

    // Everything past this point mutates, so the admin tabs are gated here
    // rather than per-action - a new write action cannot forget to ask.
    if (ADMIN_WRITE_TABS.has(tab) && !(await canInvite(auth.token))) {
      await sql`select log_audit(${auth.token}, ${action}, ${tab}, null, false,
                                 ${sql.json({ reason: "not an admin" })})`;
      return forbidden();
    }

    const baseRev = body.baseRev;
    let out: Record<string, unknown>;

    switch (action) {
      case "write": {
        const data = (body.data ?? []) as Record<string, unknown>[];
        out = await withRev(tab, baseRev, true, (tx) => {
          // Same guard, same wording as writeTab (apps-script-Code.gs:832).
          // Without it an empty payload WIPES the tab for every device: the
          // per-tab "↻ Re-push all" button (js/render.js:1851) calls pushTab
          // with whatever STATE holds, and STATE holds [] on a device whose
          // pull for that tab never landed. Sheets refused that; Postgres would
          // obey it, and for MSK there is no tombstone to recover from.
          //
          // It sits INSIDE withRev, not before it, because the old backend ran
          // the staleness check first (withRevLock wraps writeTab, :205) — so a
          // stale empty write is still a conflict, not this error. withRev
          // skips the revision bump on any {error}, so nothing moves either way.
          if (!Array.isArray(data) || data.length === 0) {
            return Promise.resolve({ error: "Data must be a non-empty array of objects" });
          }
          return writeWholeTab(tx, tab, data);
        });
        break;
      }
      case "append":
        out = await withRev(tab, baseRev, false, (tx) =>
          appendOne(tx, tab, (body.row ?? {}) as Record<string, unknown>));
        break;
      case "appendMany": {
        const rows = (body.rows ?? []) as Record<string, unknown>[];
        // Same guard, same wording as appendMany (apps-script-Code.gs:1028).
        if (!Array.isArray(rows) || rows.length === 0) {
          out = { error: "Rows must be a non-empty array" };
          break;
        }
        out = await withRev(tab, baseRev, false, async (tx) => {
          let n = 0;
          for (const r of rows) {
            const res = await appendOne(tx, tab, r);
            if ("error" in res) return res;
            if (res.action !== "noop") n++;
          }
          // Count APPENDS, not rows accepted: a retried batch whose ids are all
          // present already appended nothing (apps-script-Code.gs:1057). The
          // `noop` marker is load-bearing — withRev reads it to skip the
          // revision bump, so a replay does not wake every other device for a
          // pull that would find no change.
          return n === 0
            ? { rowsAppended: 0, action: "noop", note: "all ids already present" }
            : { rowsAppended: n };
        });
        break;
      }
      case "upsertRow":
        out = await withRev(tab, baseRev, false, (tx) =>
          upsertOne(tx, tab, (body.row ?? {}) as Record<string, unknown>));
        break;
      case "applyOps": {
        const ops = (body.ops ?? []) as Record<string, unknown>[];
        // Same ceiling as MAX_BATCH_OPS (apps-script-Code.gs:1148); the client
        // packs at most 50 (js/sync.js:463) so this is headroom, not a limit.
        if (ops.length > 200) { out = { error: "Too many ops (max 200)" }; break; }
        out = await withRev(tab, baseRev, false, (tx) => applyOps(tx, tab, ops));
        break;
      }
      case "deleteRowById":
        out = await withRev(tab, baseRev, false, (tx) => deleteOne(tx, tab, body.id));
        break;
      default:
        // deleteRow / updateRow were index-based and had no frontend caller.
        // "Invalid request" is also sync.js's probe for a backend without
        // applyOps (js/sync.js:571) — correct here, since these are unsupported.
        return json({ error: "Invalid request" });
    }

    // _audit never goes back to the client — it holds row contents, and a write
    // response has no reason to carry them. Lift it out before responding.
    const aud = (out._audit ?? null) as
      { before?: unknown; after?: unknown; touchedSensitive?: string[] } | null;
    delete out._audit;

    await sql`select log_audit(${auth.token}, ${action}, ${tab},
                               ${String(body.id ?? (body.row as Record<string, unknown>)?.id ?? "")},
                               ${!out.error && !out.conflict},
                               ${sql.json({
                                 reason: (out.error ?? null) as string | null,
                                 ...(aud?.touchedSensitive?.length
                                   ? { sensitiveWritten: aud.touchedSensitive }
                                   : {}),
                               })},
                               ${aud?.before ? sql.json(aud.before as postgres.JSONValue) : null},
                               ${aud?.after ? sql.json(aud.after as postgres.JSONValue) : null})`;
    return json(out);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});
