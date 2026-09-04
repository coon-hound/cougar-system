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
};

// Sheet tab → readAll response key (mirrors TAB_TO_STATE, js/state.js:32-45).
// Note rm/polar/conductDetail do NOT match their tab names.
const STATE_KEY: Record<string, string> = {
  Roster: "roster", Medical: "medical", Attendance: "attendance",
  IPPT: "ippt", RouteMarch: "rm", SOC: "soc", PolarFlow: "polar",
  ConductDetail: "conductDetail", Appointments: "appointments",
  Leave: "leave", MSK: "msk", Conducts: "conducts",
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

  const [existing] = await tx`select 1 from ${tx(table)} where "id" = ${id}`;
  if (!existing) await tx`insert into ${tx(table)} ("id") values (${id})`;

  await tx`
    update ${tx(table)}
       set ${joinFrags(tx, setFragments(tx, real))},
           extra = extra || ${tx.json(extra as postgres.JSONValue)},
           deleted_at = null
     where "id" = ${id}`;

  return { action: existing ? "updated" : "appended", id };
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
  const rows = await tx`
    update ${tx(table)} set deleted_at = now()
     where "id" = ${key} and deleted_at is null
     returning "id"`;
  return { action: rows.length ? "deleted" : "noop", id: key };
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
      if (r && "error" in r) { failed++; results.push(r); }
      else { applied++; results.push(r); }
    } catch (e) {
      failed++;
      results.push({ error: String((e as Error)?.message ?? e) });
    }
  }
  return { applied, failed, results };
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

async function redeemInvite(token: string) {
  return await sql.begin(async (tx) => {
    const [inv] = await tx`select * from invites where token = ${token} for update`;
    if (!inv) return { error: "Invalid invite" };
    if (inv.expires_at && new Date(inv.expires_at) <= new Date()) return { error: "Invite expired" };
    if (inv.used_count >= inv.max_uses) return { error: "Invite already used" };

    const authToken = crypto.randomUUID();
    await tx`
      insert into auth_tokens (token, person, device_label)
      values (${authToken}, ${inv.token}, 'redeemed')`;
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

    const tab = String(body.tab ?? "");
    const table = TABLE[tab];
    if (!table && action !== "rowCount") return json({ error: `Tab '${tab}' not found` });

    if (action === "rowCount") {
      if (!table) return json({ error: `Tab '${tab}' not found` });
      const [r] = await sql`select count(*)::int as n from ${sql(table)} where deleted_at is null`;
      return json({ ok: true, tab, dataRows: r.n });
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

    await sql`select log_audit(${auth.token}, ${action}, ${tab},
                               ${String(body.id ?? (body.row as Record<string, unknown>)?.id ?? "")},
                               ${!out.error && !out.conflict},
                               ${sql.json({ reason: (out.error ?? null) as string | null })})`;
    return json(out);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});
