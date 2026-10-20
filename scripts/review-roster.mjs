#!/usr/bin/env node
// Read-only incident dossier. The output is deliberately NOT an approved repair.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nameKey } from "./intake-plan.mjs";
import { fingerprint, linkedFingerprints } from "./repair-roster.mjs";
import { parseForms, matchForms, profileValue } from "./forms-match.mjs";

const SENSITIVE = new Set(["dob", "address", "nokName", "nokRelation", "nokPhone", "allergies", "bloodType", "otherMedical"]);
const BOOKKEEPING = new Set(["id", "4d", "pid", "intake", "deleted_at", "_pk", "created_at", "updated_at", "extra"]);
export async function reviewIncident(sql, incidentAt, { forms = [], formSource = "", encKey = "" } = {}) {
  if (!Number.isFinite(Date.parse(incidentAt))) throw new Error("A precise incident timestamp is required");
  return sql.begin("isolation level repeatable read read only", async tx => {
    const exists = await tx`select to_regclass('public.seating_state') as table`;
    let seatEpoch = null;
    if (exists[0].table) {
      await tx`select pg_advisory_xact_lock_shared(6413161608::bigint)`;
      seatEpoch = Number((await tx`select seating_epoch() as epoch`)[0].epoch);
    }
    const moved = await tx`
      select l.pid,l.name as intended_name,l.old_d4,l.new_d4,to_jsonb(r) as raw,p.nric_hash
      from intake_log l join roster r on r.pid=l.pid and r.id=l.new_d4 join people p on p.pid=l.pid
      where l.at=${incidentAt}::text::timestamptz and l.matched_by in ('move','swap','reseat') and r.deleted_at is null order by l.new_d4`;
    const count = await tx`select count(*)::int as n from intake_log where at=${incidentAt}::text::timestamptz and matched_by in ('move','swap','reseat')`;
    if (!moved.length || moved.length !== count[0].n) throw new Error("Incident mapping is incomplete or seats have changed; investigate before preparing a repair");
    const formMatches = new Map(moved.map(m => [m.new_d4, forms.length ? matchForms({name:m.intended_name,nricHash:m.nric_hash},forms) : null]));
    const linkedFingerprintsById = await linkedFingerprints(tx, moved.map(m=>m.new_d4));
    const people = [], records = [], evidence = [];
    for (const m of moved) {
      const row = m.raw;
      const audits = await tx`select id,at,action,before,after,detail from audit
        where tab='Roster' and ok and row_id=${m.new_d4} and at>=${incidentAt}::text::timestamptz order by at`;
      const fields = Object.keys(row).filter(k => !BOOKKEEPING.has(k));
      people.push({ id: m.new_d4, pid: m.pid, expectedFingerprint: fingerprint(row),
        fieldReview: Object.fromEntries(fields.map(k => [k,{ verified: false, source: "" }])),
        linkedReview: { verified: false, source: "", expectedFingerprint:linkedFingerprintsById.get(m.new_d4) },
      });
      const formMatch = formMatches.get(m.new_d4);
      const profileChecks = [];
      const nameCorrupted = row.name !== m.intended_name;
      const verifiedFixes = new Map();
      if (formMatch?.matched && !formMatch.issues.length && encKey) {
        const [api] = await tx`select roster_api_row(r,${encKey}) as row from roster r where id=${m.new_d4}`;
        const donor = moved.find(other => other.old_d4 === m.new_d4 && other.pid !== m.pid);
        const donorMatch = donor ? formMatches.get(donor.new_d4) : null;
        for (const [field,value] of Object.entries(formMatch.form.fields)) {
          const equal = profileValue(field,api.row[field]) === profileValue(field,value);
          const donorValue = donorMatch?.form?.fields[field];
          const inheritedFromOldOccupant = nameCorrupted && donorValue != null &&
            profileValue(field,api.row[field]) === profileValue(field,donorValue) && !equal;
          const source = `${formSource} line ${formMatch.form.line} (${formMatch.method})`;
          profileChecks.push({field,matchesSource:equal,matchesOldOccupant:inheritedFromOldOccupant});
          if (equal || inheritedFromOldOccupant) people[people.length-1].fieldReview[field]={verified:true,source};
          if (inheritedFromOldOccupant) verifiedFixes.set(field,{field,value,verified:true,source});
        }
        if (nameCorrupted) {
          const source=`intake_log at ${incidentAt}; corroborated by ${formSource} line ${formMatch.form.line} (${formMatch.method})`;
          verifiedFixes.set("name",{field:"name",value:m.intended_name,verified:true,source});
          people[people.length-1].fieldReview.name={verified:true,source};
        } else people[people.length-1].fieldReview.name={verified:true,source:`intake_log at ${incidentAt}; matching authoritative Forms identity`};
      }
      // A correctly identified audit snapshot preserves valid later edits
      // that a stale full-profile write subsequently replaced. Sensitive audit
      // placeholders are never candidates for a real field replacement.
      if (nameCorrupted) {
        const trusted = new Map();
        for (const audit of audits) {
          for (const side of ["before","after"]) {
            const snapshot=audit[side];
            if (!snapshot || snapshot.pid!==m.pid || nameKey(snapshot.name)!==nameKey(m.intended_name)) continue;
            for (const [field,value] of Object.entries(snapshot)) {
              if (BOOKKEEPING.has(field) || SENSITIVE.has(field) || !fields.includes(field)) continue;
              trusted.set(field,{value:value == null ? null : String(value),source:`audit ${audit.id} ${side}, correctly identified person ${m.pid}`});
            }
          }
        }
        for (const [field,prior] of trusted) {
          people[people.length-1].fieldReview[field]={verified:true,source:prior.source};
          if (profileValue(field,row[field])!==profileValue(field,prior.value)) verifiedFixes.set(field,{field,...prior,verified:true});
          else verifiedFixes.delete(field);
        }
      }
      evidence.push({ profileChecks, formMatch: formMatch ? {
        matched:formMatch.matched, method:formMatch.method, issues:formMatch.issues, candidates:formMatch.candidates,
        source:formSource, sourceFields:formMatch.form?.fields ?? null,
      } : null, id: m.new_d4, pid: m.pid, oldSeat: m.old_d4, intendedName: m.intended_name,
        current: Object.fromEntries(fields.map(k => [k,SENSITIVE.has(k) ? "[encrypted; verify authoritative source]" : row[k]])),
        auditedWrites: audits.map(a => ({ auditId:a.id, at:a.at, action:a.action,
          changedFields: a.before && a.after ? Object.keys(a.after).filter(k => JSON.stringify(a.before[k])!==JSON.stringify(a.after[k])) : null,
          sensitiveFieldsSubmitted:a.detail.sensitiveWritten ?? [],
        })),
      });
      if (row.name !== m.intended_name) {
        // A mismatch is an investigation candidate, not permission to trust
        // every historical value. Blank source/verification blocks application.
        records.push({ table:"roster", key:m.new_d4, subjectPid:m.pid, expectedFingerprint:fingerprint(row),
          fields:verifiedFixes.size ? [...verifiedFixes.values()] : [{field:"name",value:m.intended_name,verified:false,source:""}],
        });
      }
    }
    const batches = await tx`select id,at,action,tab from audit where ok and action='applyOps' and at>=${incidentAt}::text::timestamptz and before is null and after is null order by at`;
    const linked = await tx`select c.relname as table from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped and lower(a.attname)='d4' and c.relname<>'audit' order by c.relname`;
    const linkedCounts = {};
    for (const t of linked) {
      linkedCounts[t.table] = await tx`select d4,count(*)::int as records from ${tx(t.table)} where d4=any(${moved.map(m=>m.new_d4)}) group by d4 order by d4`;
    }
    return { version:1, incidentAt, seatEpoch, people, records,
      review: { ready:false, movedPeople:moved.length, candidateRepairs:records.length, evidence, batchesWithoutIndividualHistory:batches, linkedCounts },
    };
  });
}

export async function main(argv=process.argv.slice(2)) {
  const incidentAt=argv[argv.indexOf("--incident")+1], output=argv[argv.indexOf("--output")+1];
  if (!argv.includes("--incident") || !argv.includes("--output") || !process.env.DATABASE_URL) throw new Error("Usage: DATABASE_URL=... node scripts/review-roster.mjs --incident <exact-timestamp> --output <private-file-outside-repo>");
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
  const common=execFileSync("git",["rev-parse","--git-common-dir"],{cwd:root,encoding:"utf8"}).trim();
  const repository=path.dirname(path.resolve(root,common));
  const absolute=path.resolve(fs.realpathSync(path.dirname(output)),path.basename(output));
  if (absolute===repository || absolute.startsWith(repository+path.sep)) throw new Error("Personnel reviews must remain outside the repository");
  const {default:postgres}=await import("postgres");
  const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
  try {
    let forms=[], formSource="";
    if (argv.includes("--forms")) {
      if (!process.env.COUGAR_ENC_KEY) throw new Error("Encryption key required for keyed NRIC matching");
      const formFile=argv[argv.indexOf("--forms")+1], text=fs.readFileSync(formFile,"utf8");
      const hash=s=>crypto.createHmac("sha256",process.env.COUGAR_ENC_KEY).update(s).digest("hex");
      forms=parseForms(text,hash);
      formSource=`${path.basename(formFile)} sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
    }
    const result=await reviewIncident(sql,incidentAt,{forms,formSource,encKey:process.env.COUGAR_ENC_KEY || ""});
    fs.writeFileSync(absolute,JSON.stringify(result,null,2)+"\n",{mode:0o600,flag:"wx"});
    console.log(JSON.stringify({file:absolute,movedPeople:result.people.length,candidateRepairs:result.records.length,matchedForms:result.review.evidence.filter(e=>e.formMatch?.matched).length,unmatchedForms:result.review.evidence.filter(e=>e.formMatch&&!e.formMatch.matched).map(e=>e.id),ready:false}));
  } finally {await sql.end();}
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
