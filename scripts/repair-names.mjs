#!/usr/bin/env node
// Name-only staged repair. This deliberately cannot certify or change profiles
// or linked history. Private manifests must remain outside the public checkout.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { fingerprint, manifestChecksum } from "./repair-roster.mjs";

export async function repairNames(sql, manifest, { apply = false, checksum } = {}) {
  if (manifest?.version !== 1 || !Number.isFinite(Date.parse(manifest.incidentAt)) ||
      !Array.isArray(manifest.names) || !manifest.names.length) throw new Error("Invalid name-only manifest");
  const keys = new Set(), pids = new Set();
  for (const n of manifest.names) {
    if (!/^\d{4}$/.test(n.id) || !n.pid || typeof n.name !== "string" || !n.name.trim() ||
        !/^[a-f0-9]{64}$/.test(n.expectedFingerprint || "") || n.verified !== true || !n.source?.trim() ||
        keys.has(n.id) || pids.has(n.pid)) throw new Error("Names need unique seats, verified sources and fingerprints");
    keys.add(n.id); pids.add(n.pid);
  }
  const digest = manifestChecksum(manifest);
  if (apply && checksum !== digest) throw new Error("Apply requires the exact preview checksum");
  return sql.begin(apply ? "" : "isolation level repeatable read read only", async tx => {
    if (apply) {
      await tx`select pg_advisory_xact_lock(6413161608::bigint)`;
      // Legacy API writes lock the revision before the roster. Match that
      // order so a writer cannot hold the rev while waiting on our table lock.
      await tx`select rev from revs where tab='Roster' for update`;
      await tx`lock table roster, people, intake_log, roster_name_guards in share row exclusive mode`;
    }
    // The database trigger is mandatory, including when the Edge Function is
    // still the legacy version. Do not allow a silently disabled guard.
    const guard = await tx`select 1 from pg_trigger where tgrelid='roster'::regclass
      and tgname='roster_verified_name' and tgenabled='O' and not tgisinternal`;
    if (guard.length !== 1) throw new Error("Verified-name database guard must be enabled");
    const pending = [];
    for (const n of manifest.names) {
      const [row] = await tx`select to_jsonb(r) as raw,p.name as registered_name,p.last_d4
        from roster r join people p on p.pid=r.pid where r.id=${n.id} and r.deleted_at is null`;
      if (!row || row.raw.pid !== n.pid || row.last_d4 !== n.id || row.registered_name !== n.name) throw new Error("Verified person or registered name changed");
      const log = await tx`select 1 from intake_log where at=${manifest.incidentAt}::text::timestamptz
        and pid=${n.pid} and new_d4=${n.id} and name=${n.name} and matched_by in ('move','swap','reseat')`;
      if (log.length !== 1) throw new Error("Name must agree with the exact incident seating log");
      const [registered] = await tx`select expected_name from roster_name_guards where pid=${n.pid}`;
      if (registered && registered.expected_name !== n.name) throw new Error("A different verified-name guard exists");
      if (row.raw.name === n.name && registered?.expected_name === n.name) continue;
      if (fingerprint(row.raw) !== n.expectedFingerprint) throw new Error("A roster row changed since preview");
      pending.push({ n, before: row.raw });
    }
    if (!apply) return { checksum: digest, ready: true, records: pending.length, namesOnly: true };
    for (const { n, before } of pending) {
      await tx`insert into roster_name_guards(pid,expected_name) values (${n.pid},${n.name}) on conflict(pid) do nothing`;
      await tx`update roster set name=${n.name} where id=${n.id} and pid=${n.pid}`;
      const [after] = await tx`select to_jsonb(r) as raw from roster r where id=${n.id}`;
      await tx`select log_audit(null,'repairNames','Roster',${n.id},true,
        ${tx.json({checksum:digest, fields:["name"], source:n.source})},${tx.json(before)},${tx.json(after.raw)})`;
    }
    if (pending.length) {
      await tx`select bump_rev('Roster')`;
      const [epoch] = await tx`select to_regclass('public.seating_state') as present`;
      if (epoch.present) {
        const [{ epoch: current }] = await tx`select seating_epoch() as epoch`;
        await tx`select begin_seating_change(${current})`;
      }
    }
    return { checksum: digest, applied: pending.length > 0, records: pending.length, namesOnly: true };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file || !process.env.DATABASE_URL) throw new Error("Usage: node scripts/repair-names.mjs <private-manifest.json> [--apply --checksum <preview-checksum>]");
  const absolute = fs.realpathSync(file), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
  const common = execFileSync("git",["rev-parse","--git-common-dir"],{cwd:root,encoding:"utf8"}).trim();
  const repository = path.dirname(path.resolve(root,common));
  if (absolute === repository || absolute.startsWith(repository+path.sep) || (fs.statSync(absolute).mode & 0o077)) throw new Error("Manifest must be private and outside the repository");
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL,{prepare:false,max:1});
  try { console.log(JSON.stringify(await repairNames(sql,JSON.parse(fs.readFileSync(absolute,"utf8")),{
    apply:argv.includes("--apply"),checksum:argv[argv.indexOf("--checksum")+1],
  }))); } finally { await sql.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
