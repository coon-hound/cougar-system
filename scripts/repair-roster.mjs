#!/usr/bin/env node
// Verified, field-level repairs. Personnel manifests stay outside this public
// repository. Preview is the default; --apply also requires --checksum.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPAIR_TABLES = {
  roster: "Roster", medical: "Medical", attendance: "Attendance", ippt: "IPPT",
  routemarch: "RouteMarch", soc: "SOC", polarflow: "PolarFlow",
  conductdetail: "ConductDetail", appointments: "Appointments", leave: "Leave", msk: "MSK",
};
const ENCRYPTED = new Set(["dob", "address", "nokName", "nokRelation", "nokPhone", "allergies", "bloodType", "otherMedical"]);
const IMMUTABLE = new Set(["id", "4d", "pid", "intake", "deleted_at", "_pk", "created_at", "updated_at", "extra"]);

function canonical(v) {
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return { bytea: v.toString("hex") };
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
export const fingerprint = row => crypto.createHash("sha256").update(JSON.stringify(canonical(row))).digest("hex");
export const manifestChecksum = manifest => fingerprint(manifest);

// Include every supported personnel-linked table in the owner review stamp.
// Authentication activity is excluded because it is not personnel history.
export async function linkedFingerprints(db, ids) {
  const rowsByPerson = new Map(ids.map(id => [id, {}]));
  const linked = await db`select table_name from information_schema.columns
    where table_schema='public' and column_name='d4' order by table_name`;
  for (const { table_name: name } of linked) {
    if (!REPAIR_TABLES[name] || name === "roster") continue;
    const rows = await db`select to_jsonb(r) as raw from ${db(name)} r where d4=any(${ids})`;
    for (const id of ids) rowsByPerson.get(id)[name] = rows.filter(r=>r.raw.d4===id).map(r=>r.raw).sort((a,b)=>fingerprint(a).localeCompare(fingerprint(b)));
  }
  return new Map(ids.map(id => [id, fingerprint(rowsByPerson.get(id))]));
}


export function validateManifest(m) {
  if (m?.version !== 1 || !Number.isSafeInteger(m.seatEpoch) || m.seatEpoch < 1) throw new Error("Invalid manifest version or seating version");
  if (!m.incidentAt || !Number.isFinite(Date.parse(m.incidentAt))) throw new Error("Incident timestamp is required");
  if (!Array.isArray(m.people) || !m.people.length || !Array.isArray(m.records) || !m.records.length) throw new Error("People and repair records are required");
  const people = new Map();
  const seats = new Set();
  for (const p of m.people) {
    if (!/^[a-f0-9]{64}$/.test(p.expectedFingerprint ?? "")) throw new Error("Reviewed-person fingerprint required");
    if (!p.pid || !/^\d{4}$/.test(p.id) || people.has(p.pid) || seats.has(p.id)) throw new Error("Duplicate or invalid person/seat");
    if (!/^[a-f0-9]{64}$/.test(p.linkedReview?.expectedFingerprint ?? "")) throw new Error("Linked-record review fingerprint required");
    if (p.linkedReview?.verified !== true || !p.linkedReview.source?.trim()) throw new Error("Linked-record review is incomplete");
    if (!p.fieldReview || !Object.keys(p.fieldReview).length) throw new Error("Roster-field review is required");
    for (const review of Object.values(p.fieldReview)) {
      if (review?.verified !== true || !review.source?.trim()) throw new Error("A roster field remains unverified");
    }
    people.set(p.pid, p);
    seats.add(p.id);
  }
  const targets = new Set();
  for (const r of m.records) {
    if (!REPAIR_TABLES[r.table] || !people.has(r.subjectPid)) throw new Error("Unknown table or unreviewed person");
    const keyColumn = r.table === "msk" ? "_pk" : "id";
    if (r.key == null || !/^[a-f0-9]{64}$/.test(r.expectedFingerprint ?? "")) throw new Error("Record key and fingerprint required");
    const target = JSON.stringify([r.table, r.key]);
    if (targets.has(target)) throw new Error("Duplicate repair target");
    targets.add(target);
    if (r.table === "roster" && r.key !== people.get(r.subjectPid).id) throw new Error("Roster repair cannot change seating");
    if (!Array.isArray(r.fields) || !r.fields.length) throw new Error("Repair fields are required");
    const fields = new Set();
    for (const f of r.fields) {
      if (!f.field || fields.has(f.field) || IMMUTABLE.has(f.field) || f.field === keyColumn) throw new Error("Duplicate or immutable repair field");
      if (f.verified !== true || !f.source?.trim() || !Object.prototype.hasOwnProperty.call(f, "value")) throw new Error("An affected field is unverified");
      if (f.value !== null && typeof f.value !== "string") throw new Error("Replacement values must be strings or null");
      if (f.field === "d4" && f.value !== people.get(r.subjectPid).id) throw new Error("Linked-record replacement must belong to its reviewed person");
      fields.add(f.field);
    }
  }
  return people;
}

// Raw encrypted columns participate in fingerprints; no decrypted values are
// needed for preconditions, snapshots or logs. Decrypt only a verified replacement.
export async function repair(sql, manifest, { apply = false, checksum } = {}) {
  const people = validateManifest(manifest);
  const digest = manifestChecksum(manifest);
  if (apply && checksum !== digest) throw new Error("Apply requires the exact preview checksum");
  return sql.begin(apply ? "" : "isolation level repeatable read read only", async tx => {
    if (apply) await tx`select pg_advisory_xact_lock(6413161608::bigint)`;
    else await tx`select pg_advisory_xact_lock_shared(6413161608::bigint)`;
    const [receipt] = await tx`select checksum, records, seat_epoch from roster_repairs where checksum = ${digest}`;
    if (receipt) return { checksum: digest, applied: false, alreadyApplied: true, records: receipt.records, seatEpoch: Number(receipt.seat_epoch) };
    const [{ epoch }] = await tx`select seating_epoch() as epoch`;
    if (Number(epoch) !== manifest.seatEpoch) throw new Error("Seating changed since verification");
    const affected = await tx`select pid,new_d4 from intake_log where at=${manifest.incidentAt}::text::timestamptz and matched_by in ('move','swap','reseat')`;
    if (!affected.length || affected.length !== people.size || affected.some(r => people.get(r.pid)?.id !== r.new_d4)) {
      throw new Error("Manifest must review every person moved in the incident, exactly once");
    }
    if (apply) {
      // Protect verification from direct operational scripts as well as API
      // writes; table locks also cover new child rows, not just existing ones.
      for (const table of Object.keys(REPAIR_TABLES).sort()) {
        await tx`lock table ${tx(table)} in share row exclusive mode`;
      }
    }
    const linked = await linkedFingerprints(tx, [...people.values()].map(p=>p.id));
    for (const person of people.values()) {
      if (linked.get(person.id) !== person.linkedReview.expectedFingerprint) throw new Error("Linked history changed since verification; review it again");
      const [row] = await tx`select to_jsonb(r) as raw from roster r where id = ${person.id} and deleted_at is null`;
      if (!row || row.raw.pid !== person.pid) throw new Error("Verified person no longer owns that seat");
      if (fingerprint(row.raw) !== person.expectedFingerprint) throw new Error("A reviewed person changed; review the incident again");
      const fields = Object.keys(row.raw).filter(k => !IMMUTABLE.has(k));
      for (const field of fields) if (!person.fieldReview[field]) throw new Error(`Roster review missing field: ${field}`);
    }
    const prepared = [];
    for (const record of manifest.records) {
      const key = record.table === "msk" ? "_pk" : "id";
      const [row] = await tx`select to_jsonb(r) as raw from ${tx(record.table)} r where ${tx(key)} = ${record.key}`;
      if (!row || row.raw.deleted_at != null || fingerprint(row.raw) !== record.expectedFingerprint) throw new Error("A verified record changed; review it again");
      if (record.table === "roster" && row.raw.pid !== record.subjectPid) throw new Error("Person changed since verification");
      const person = people.get(record.subjectPid);
      const fixesD4 = record.fields.some(f => f.field === "d4");
      if (record.table !== "roster" && row.raw.d4 != null && !fixesD4 && row.raw.d4 !== person.id) throw new Error("Linked record belongs to another seat");
      for (const f of record.fields) if (!(f.field in row.raw)) throw new Error(`Unknown repair column: ${f.field}`);
      prepared.push({ record, key, before: row.raw });
    }
    if (!apply) return { checksum: digest, ready: true, records: prepared.length, seatEpoch: Number(epoch) };
    const [{ epoch: nextEpoch }] = await tx`select begin_seating_change(${manifest.seatEpoch}) as epoch`;
    const tabs = new Set();
    for (const { record, key, before } of prepared) {
      const fragments = record.fields.map(f => {
        if (record.table === "roster" && ENCRYPTED.has(f.field)) {
          if (!process.env.COUGAR_ENC_KEY) throw new Error("Encryption key required for sensitive replacements");
          return tx`${tx(f.field)} = enc_col(${f.value}, ${process.env.COUGAR_ENC_KEY})`;
        }
        return tx`${tx(f.field)} = ${f.value}`;
      });
      const set = fragments.reduce((a, b) => tx`${a}, ${b}`);
      await tx`update ${tx(record.table)} set ${set} where ${tx(key)} = ${record.key}`;
      const [after] = await tx`select to_jsonb(r) as raw from ${tx(record.table)} r where ${tx(key)} = ${record.key}`;
      const tab = REPAIR_TABLES[record.table];
      const sensitiveWritten = record.table === "roster" ? record.fields.filter(f => ENCRYPTED.has(f.field)).map(f => f.field) : [];
      await tx`select log_audit(null, 'repairRoster', ${tab}, ${String(record.key)}, true,
        ${tx.json({ checksum: digest, sensitiveWritten })}, ${tx.json(before)}, ${tx.json(after.raw)})`;
      tabs.add(tab);
    }
    for (const tab of tabs) await tx`select bump_rev(${tab})`;
    await tx`insert into roster_repairs (checksum, seat_epoch, records) values (${digest}, ${nextEpoch}, ${prepared.length})`;
    return { checksum: digest, applied: true, records: prepared.length, seatEpoch: Number(nextEpoch) };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const file = argv.find(a => !a.startsWith("--"));
  if (!file || !process.env.DATABASE_URL) throw new Error("Usage: DATABASE_URL=... node scripts/repair-roster.mjs <manifest.json> [--apply --checksum <preview-checksum>]");
  const absolute = fs.realpathSync(file);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
  const repository = path.dirname(path.resolve(root, common));
  if (absolute === repository || absolute.startsWith(repository + path.sep) || absolute.includes(`${path.sep}.worktrees${path.sep}`)) throw new Error("Personnel manifests must be outside the repository");
  if (fs.statSync(absolute).mode & 0o077) throw new Error("Manifest must be private (chmod 600)");
  const manifest = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  try { console.log(JSON.stringify(await repair(sql, manifest, { apply: argv.includes("--apply"), checksum: argv[argv.indexOf("--checksum") + 1] }))); }
  finally { await sql.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
