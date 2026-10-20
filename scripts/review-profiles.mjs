#!/usr/bin/env node
// Private, human-readable verification. No data is written to the database.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TABLES = {
  medical:["id","date","status","reason","startDate","endDate","inCamp","location"],
  leave:["id","type","reason","startDate","endDate","days"],
  appointments:["id","date","time","reason","location","outOfCamp","resolved"],
  msk:["_pk","timestamp","type","description","physioDate","exercises","cleared"],
  ippt:["id","date","series","attempt","score","award"],
  routemarch:["id","date","rmNum","time","pass"],
  soc:["id","date","attempt","time","pass"],
  polarflow:["id","date","conductId","avgHr","maxHr","calories","duration"],
  conductdetail:["id","date","conduct","type","reason","program"],
};
const cell = value => String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/[\[\]`]/g,"\\$&").replace(/\|/g,"\\|").replace(/[\r\n]+/g,"; ") || "(blank)";
const table = (columns,rows) => [
  `| ${columns.map(cell).join(" | ")} |`, `| ${columns.map(()=>"---").join(" | ")} |`,
  ...rows.map(row=>`| ${columns.map(k=>cell(row[k])).join(" | ")} |`),
].join("\n");

export async function profileReview(sql,dossier,encKey) {
  if (!encKey) throw new Error("Encryption key required for the owner's private verification document");
  return sql.begin("isolation level repeatable read read only",async tx=>{
    const out=["# Private roster verification", "", "This document contains personnel information. Keep it outside the public repository.", "", "No production data has been changed.", "", "Verify the proposed profile and linked records for each person. If a record belongs to someone else or a value is wrong, identify the 4D, field or record ID and correct value. Do not approve an uncertain record.", ""];
    const conducts = new Map((await tx`select id,name from conducts`).map(r=>[r.id,r.name]));
    const ids=dossier.people.map(p=>p.id);
    const affected=new Set(dossier.records.filter(r=>r.table==="roster").map(r=>r.key));
    const ordered=[...ids].sort((a,b)=>Number(affected.has(b))-Number(affected.has(a))||a.localeCompare(b));
    for (const id of ordered) {
      const evidence=dossier.review.evidence.find(e=>e.id===id);
      const [current]=await tx`select roster_api_row(r,${encKey}) as row from roster r where id=${id} and deleted_at is null`;
      if (!current || current.row.pid!==evidence.pid) throw new Error("Person-to-seat mapping changed; regenerate the verification dossier");
      const fixes=dossier.records.find(r=>r.table==="roster"&&r.key===id)?.fields || [];
      const proposed={...current.row,...Object.fromEntries(fixes.map(f=>[f.field,f.value]))};
      const form=evidence.formMatch?.sourceFields || {};
      out.push(`## ${cell(id)} - ${cell(evidence.intendedName)}${affected.has(id)?" (confirmed overwrite)":""}`, "",
        `Section: ${id[0]}-${id[1]}. Intended identity comes from the seating log and matched Forms submission.`, "");
      const fields=["name","dob","age","phone","email","height","weight","bloodType","address","nokName","nokRelation","nokPhone","allergies","otherMedical","msk","ration","highest education level","motorcycle license","groups","notes","status","outOfCamp","outSince","outReason","campIn","campInSince","location","locationSince","rank","role","program","leaveQuota"];
      const values=fields.map(field=>({Field:field,Current:current.row[field],Proposed:proposed[field],"Form source":form[field],Review:fixes.some(f=>f.field===field)?"Verified replacement proposed":!dossier.people.find(p=>p.id===id).fieldReview[field]?.verified?"Owner verification required":"Source matched"}));
      out.push(table(["Field","Current","Proposed","Form source","Review"],values),"","### Linked records","");
      for (const [name,columns] of Object.entries(TABLES)) {
        const rows=await tx`select api_row(to_jsonb(r)) as row,to_jsonb(r)->>'updated_at' as updated_at,to_jsonb(r)->>'_pk' as surrogate_key from ${tx(name)} r where d4=${id} and deleted_at is null`;
        const changed=rows.filter(r=>Date.parse(r.updated_at)>Date.parse(dossier.incidentAt));
        out.push(`#### ${name}: ${rows.length} records (${changed.length} updated after the reseat)`,"");
        if (rows.length) out.push(table([...columns,"Updated after reseat"],rows.map(r=>({...r.row,_pk:r.surrogate_key,conduct:conducts.get(r.row.conductId) || r.row.conductId,"Updated after reseat":Date.parse(r.updated_at)>Date.parse(dossier.incidentAt)?"YES - verify":"No"}))),"");
        else out.push("No live records.","");
      }
      out.push("**Verification:** confirm profile values and linked records, or list corrections.","", "---", "");
    }
    out.push("## Audit limitation", "", "Historic batch writes did not record individual before/after values. These records need your verification; absence of a name mismatch does not prove a linked record belongs to the right person.", "");
    return out.join("\n");
  });
}

export async function main(argv=process.argv.slice(2)) {
  if (!argv.includes("--review") || !argv.includes("--output") || !process.env.DATABASE_URL) throw new Error("Usage: node scripts/review-profiles.mjs --review <private-dossier.json> --output <private-report.md>");
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
  const common=execFileSync("git",["rev-parse","--git-common-dir"],{cwd:root,encoding:"utf8"}).trim();
  const repository=path.dirname(path.resolve(root,common));
  const output=argv[argv.indexOf("--output")+1];
  const absolute=path.resolve(fs.realpathSync(path.dirname(output)),path.basename(output));
  if (absolute===repository || absolute.startsWith(repository+path.sep)) throw new Error("Personnel profiles must be outside the repository");
  const dossier=JSON.parse(fs.readFileSync(argv[argv.indexOf("--review")+1],"utf8"));
  const {default:postgres}=await import("postgres");
  const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
  try {
    const content=await profileReview(sql,dossier,process.env.COUGAR_ENC_KEY);
    fs.writeFileSync(absolute,content,{mode:0o600,flag:"wx"});
    console.log(JSON.stringify({file:absolute,people:dossier.people.length,databaseChanges:0}));
  } finally {await sql.end();}
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
