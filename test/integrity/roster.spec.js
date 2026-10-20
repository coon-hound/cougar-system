const { test, expect } = require("@playwright/test");
const postgres = require("postgres");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const DB = process.env.COUGAR_INTEGRITY_DB;
const API = process.env.COUGAR_INTEGRITY_API;
if (!DB || !API) throw new Error("Run npm run test:integrity; the real backend is required");
const dbUrl = new URL(DB), apiUrl = new URL(API);
if (dbUrl.hostname !== "127.0.0.1" || dbUrl.pathname !== "/cougar_integrity" || apiUrl.hostname !== "127.0.0.1" || apiUrl.port !== "58001") {
  throw new Error("REFUSING non-isolated targets; these tests modify only their synthetic scratch database");
}
const sql = postgres(DB, { prepare: false, max: 4 });
const TOKEN = "dev-token";
const syntheticName = id => `${["ALPHA","BRAVO","CHARLIE","DELTA","ECHO","FOXTROT","GOLF","HOTEL","INDIA"][Number(id.slice(2))-1]} SYNTHETIC ${{"72":"SEVEN TWO","84":"EIGHT FOUR","93":"NINE THREE"}[id.slice(0,2)]}`;
const DATA_KEY = fs.readFileSync(path.join(ROOT, "js/state.js"), "utf8").match(/const STORAGE_KEY = "([^"]+)"/)[1];
const tabs = ["Roster", "Medical", "Attendance", "IPPT", "RouteMarch", "SOC", "PolarFlow", "ConductDetail", "Appointments", "Leave", "MSK", "Conducts", "Duty", "Calendar", "OilRules"];
let legacy, legacyDir;

async function read(action = "readAll", api = API) {
  const body = await (await fetch(`${api}?action=${action}&auth=${TOKEN}`)).json();
  expect(body.error, `Read ${action} failed`).toBeUndefined();
  return body;
}
async function post(body, api = API) {
  const response = await fetch(api, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ auth: TOKEN, ...body }) });
  expect(response.status).toBe(200);
  return response.json();
}
async function rawRows(table = "roster") {
  return await sql`select to_jsonb(r) as raw from ${sql(table)} r order by ${sql(table === "msk" ? "_pk" : "id")}`;
}
async function dbFingerprint() {
  return JSON.stringify({ roster: await rawRows(), medical: await rawRows("medical"), revs: await sql`select * from revs order by tab` });
}
async function seed() {
  await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(6413161608::bigint)`;
    const tables = (await tx`select tablename from pg_tables where schemaname='public' and tablename not in ('intakes','dropped_fields','seating_state')`).map(r => r.tablename);
    await tx`truncate table ${tx(tables)} restart identity cascade`;
    await tx`update seating_state set epoch=epoch+1`;
    await tx`insert into auth_tokens (token, person, can_invite) values (${TOKEN}, 'SYNTHETIC ADMIN', true)`;
    for (const tab of tabs) await tx`insert into revs (tab,rev) values (${tab},1)`;
    for (const sect of ["72", "84", "93"]) {
      for (let n = 1; n <= 9; n++) {
        const id = sect + String(n).padStart(2, "0");
        const pid = `P-TEST-${id}`, name = syntheticName(id);
        await tx`insert into people (pid,name,name_key,last_d4,last_intake) values (${pid},${name},${name},${id},'bootstrap')`;
        await tx`insert into roster (id,"4d",pid,name,role,rank,email,phone,notes,height,weight,groups,dob,address)
          values (${id},${'C'+id},${pid},${name},'Recruit','PTE',${id+'@example.invalid'},${'test-phone-'+id},${'verified-'+id},'175','70','',enc_col(${id+'-dob'},'local-dev-key'),enc_col(${id+'-address'},'local-dev-key'))`;
      }
    }
    await tx`insert into medical (id,d4,reason,status,date,"startDate","endDate") values ('M-A','8408','SYNTHETIC injury','LD','1 Oct 2026','1 Oct 2026','31 Dec 2026')`;
  });
}
async function swap(a = "8408", b = "8409") {
  const env = { ...process.env, DATABASE_URL: DB, COUGAR_ENC_KEY: "local-dev-key" };
  execFileSync(process.execPath, ["scripts/reseat.mjs", "--swap", a, b, "--apply"], { cwd: ROOT, env, stdio: "pipe" });
}
async function boot(page, api = API) {
  await page.route(/fonts\.google|cdn\.jsdelivr|cdnjs\.cloudflare/, route => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.addInitScript(({ api, token }) => {
    localStorage.setItem("cougar-api-url", api);
    localStorage.setItem("cougar-auth", token);
    localStorage.setItem("cougar-seen-version", "9999");
  }, { api, token: TOKEN });
  await page.goto("/index.html");
  await page.waitForFunction(() => STATE.roster.length === 27);
  await page.evaluate(() => { stopAutoRefresh(); closeModal(); STATE.nav = "roster"; render(); });
}
async function openBookOut(page, id = "8408") {
  const row = page.locator("#content tbody tr").filter({ has: page.locator("td", { hasText: new RegExp(`^${id}$`) }) });
  await row.getByTitle("Book out of camp for today or a date range").click();
  await page.fill("#f-bo-reason", "SYNTHETIC appointment");
}
async function settle(page) {
  await page.waitForFunction(() => _activePushCount === 0 && !_pullInFlight);
}

test.beforeAll(async () => {
  expect((await read("ping")).build).toBe("2026-10-14-seating-1");
  // Reproduce against the actual pre-fix Edge Function, not a fake that merely
  // imitates its bug. Its only change is the private local listening address.
  const original = execFileSync("git", ["show", "f316028:supabase/functions/api/index.ts"], { cwd: ROOT, encoding: "utf8" });
  legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cougar-legacy-api-"));
  fs.writeFileSync(path.join(legacyDir, "api.ts"), original.replace("Deno.serve(async (req) => {", 'Deno.serve({port:58002,hostname:"127.0.0.1"}, async (req) => {'));
  const log = fs.openSync(path.join(legacyDir, "api.log"), "a");
  legacy = spawn("deno", ["run", "--allow-env", "--allow-net", "--node-modules-dir=none", path.join(legacyDir, "api.ts")], {
    cwd: ROOT, env: { ...process.env, SUPABASE_DB_URL: DB, COUGAR_ENC_KEY: "local-dev-key", APPS_SCRIPT_URL: "" }, stdio: ["ignore", log, log],
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await read("ping", "http://127.0.0.1:58002/")).build === "2026-09-03-1") { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  expect(ready, "the actual pre-fix backend must run for the regression proof").toBe(true);
});
test.afterAll(async () => { if (legacy) legacy.kill(); await sql.end(); });
test.beforeEach(seed);

test("a staged name-only repair rejects stale legacy writes and preserves unreviewed history", async ({ page }) => {
  const N = await import(pathToFileURL(path.join(ROOT, "scripts/repair-names.mjs")));
  const R = await import(pathToFileURL(path.join(ROOT, "scripts/repair-roster.mjs")));
  const incidentAt = "2026-10-07T06:59:43.709837Z";
  const ids = ["8408", "9302", "9303"];
  for (const id of ids) {
    await sql`insert into intake_log(at,intake,pid,name,old_d4,new_d4,matched_by)
      values (${incidentAt}::text::timestamptz,'bootstrap',${'P-TEST-'+id},${syntheticName(id)},${id},${id},'move')`;
    await sql`update roster set name='SYNTHETIC WRONG OCCUPANT' where id=${id}`;
  }
  const original = new Map((await rawRows()).map(r=>[r.raw.id,r.raw]));
  const manifest = { version:1, incidentAt, names:ids.map(id=>({id,pid:'P-TEST-'+id,name:syntheticName(id),
    expectedFingerprint:R.fingerprint(original.get(id)),verified:true,source:'synthetic independently verified identity'})) };
  const wrong = structuredClone(manifest); wrong.names[0].name='SYNTHETIC GUESS';
  await expect(N.repairNames(sql,wrong)).rejects.toThrow('registered name changed');
  const stale = structuredClone(manifest); stale.names[1].expectedFingerprint='0'.repeat(64);
  await expect(N.repairNames(sql,stale,{apply:true,checksum:R.manifestChecksum(stale)})).rejects.toThrow('changed since preview');
  expect(await sql`select * from roster_name_guards`).toHaveLength(0);
  const initial = await dbFingerprint();
  const preview = await N.repairNames(sql,manifest);
  expect(await dbFingerprint()).toBe(initial);
  // Exercise the exact staged deployment: no seating_state visible yet.
  await sql`alter table seating_state rename to seating_state_deferred`;
  try {
    expect((await N.repairNames(sql,manifest,{apply:true,checksum:preview.checksum})).records).toBe(3);
    const after = new Map((await rawRows()).map(r=>[r.raw.id,r.raw]));
    for (const id of ids) {
      const { name: beforeName, updated_at: beforeTime, ...before } = original.get(id);
      const { name, updated_at: afterTime, ...rest } = after.get(id);
      expect(name).toBe(syntheticName(id));
      expect(rest).toEqual(before);
    }
    const guarded = await dbFingerprint();
    const rejected = await post({action:'upsertRow',tab:'Roster',row:{id:'8408',name:'SYNTHETIC WRONG OCCUPANT',email:'stale@example.invalid'}},'http://127.0.0.1:58002/');
    expect(rejected.error).toBeTruthy();
    expect(await dbFingerprint()).toBe(guarded);
    const batch = await post({action:'applyOps',tab:'Roster',ops:[
      {op:'upsert',row:{id:'8407',name:syntheticName('8407'),notes:'SYNTHETIC valid unrelated edit'}},
      {op:'upsert',row:{id:'8408',name:'SYNTHETIC WRONG OCCUPANT'}},
    ]},'http://127.0.0.1:58002/');
    expect(batch.applied).toBe(1);
    expect(batch.failed).toBe(1);
    expect(batch.results[1].error).toContain('Verified roster name changed');
    expect((await rawRows()).find(r=>r.raw.id==='8408').raw).toEqual(after.get('8408'));
    expect((await N.repairNames(sql,manifest,{apply:true,checksum:preview.checksum})).records).toBe(0);
    const accepted = await post({action:'upsertRow',tab:'Roster',row:{id:'8408',name:syntheticName('8408'),notes:'SYNTHETIC legitimate edit'}},'http://127.0.0.1:58002/');
    expect(accepted.error).toBeUndefined();
    expect((await read('readAll','http://127.0.0.1:58002/')).roster.find(r=>r.id==='8408').name).toBe(syntheticName('8408'));
  } finally { await sql`alter table seating_state_deferred rename to seating_state`; }
  await boot(page);
  for (const id of ids) await expect(page.locator('#content tbody tr').filter({has:page.locator('td',{hasText:new RegExp(`^${id}$`)})})).toContainText(syntheticName(id));
});

test("the pre-fix backend reproduces the stale-phone overwrite", async ({ page }) => {
  await boot(page, "http://127.0.0.1:58002/");
  await openBookOut(page);
  await swap();
  await page.click("#f-bo-submit");
  await settle(page);
  const [row] = await sql`select name,pid,email from roster where id='8408'`;
  expect(row.pid).toBe("P-TEST-8409");
  expect(row.name).toBe(syntheticName("8408"));
  expect(row.email).toBe("8408@example.invalid");
});

test("a stale phone cannot overwrite the new occupant; another browser sees the correct roster", async ({ page, context }) => {
  await boot(page);
  await openBookOut(page);
  await swap();
  const expected = await dbFingerprint();
  const rejection = page.waitForResponse(async r => r.url() === API && r.request().method() === "POST" && (await r.json()).reason === "SEATING_CHANGED");
  await page.click("#f-bo-submit");
  expect((await (await rejection).json()).code).toBe(409);
  await expect(page.locator("#sync-banner")).toContainText("Old unsaved edits were discarded");
  await settle(page);
  expect(await dbFingerprint()).toBe(expected);
  expect(await page.evaluate(() => STATE.roster.find(r => r.id === "8408").name)).toBe(syntheticName("8409"));
  expect(await page.evaluate(() => STATE.dirty.size)).toBe(0);
  expect(await page.evaluate(() => _lastConflictedReplace)).toBeNull();
  const other = await context.newPage();
  await boot(other);
  expect(await other.evaluate(() => STATE.roster.find(r => r.id === "8408").name)).toBe(syntheticName("8409"));
  await other.close();
});

test("missing or stale seating versions block every mutation path without a partial write", async () => {
  const all = await read();
  await swap();
  const before = await dbFingerprint();
  const bodies = [
    { action: "upsertRow", tab: "Roster", row: all.roster.find(r => r.id === "8408") },
    { action: "append", tab: "Roster", row: { id: "8410", name: "SYNTHETIC NEW" } },
    { action: "appendMany", tab: "Medical", rows: [{ id: "M-B", d4: "8408" }] },
    { action: "deleteRowById", tab: "Medical", id: "M-A" },
    { action: "write", tab: "Roster", data: all.roster, baseRev: all.revs.Roster },
    { action: "write", tab: "MSK", data: [{ d4: "8408", type: "SYNTHETIC" }] },
    { action: "applyOps", tab: "Roster", ops: [{ op: "upsert", row: { id: "8408", name: "SYNTHETIC WRONG" } }, { op: "delete", id: "8409" }] },
    { action: "upsertRow", tab: "Medical", row: { id: "M-A", d4: "8409", reason: "SYNTHETIC WRONG" } },
  ];
  for (const body of bodies) {
    for (const epoch of [undefined, all.seatEpoch]) {
      const res = await post({ ...body, seatEpoch: epoch });
      expect(res.reason).toBe("SEATING_CHANGED");
      expect(res.code).toBe(409);
      expect(await dbFingerprint()).toBe(before);
    }
  }
});

test("a write waiting behind a seating transaction validates the version after the lock", async () => {
  const all = await read();
  let pending;
  await sql.begin(async tx => {
    await tx`select begin_seating_change(${all.seatEpoch})`;
    pending = post({ action:"upsertRow", tab:"Roster", seatEpoch:all.seatEpoch, row:{id:"8408",name:"SYNTHETIC WRONG"} });
    await expect.poll(async () => Number((await sql`select count(*) as n from pg_locks where locktype='advisory' and not granted`)[0].n)).toBeGreaterThan(0);
  });
  expect((await pending).reason).toBe("SEATING_CHANGED");
  expect((await sql`select name from roster where id='8408'`)[0].name).toBe(syntheticName("8408"));
});

test("offline persisted edits cannot be retagged and replayed after a reseat", async ({ page }) => {
  await boot(page);
  const epoch = await page.evaluate(() => STATE.seatEpoch);
  await openBookOut(page);
  await page.route(API, route => route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue());
  await page.evaluate(() => Object.defineProperty(navigator, "onLine", { value: false, configurable: true }));
  await page.click("#f-bo-submit");
  await page.waitForFunction(() => STATE.dirty.has("Roster"));
  const stash = await page.evaluate(() => JSON.parse(localStorage.getItem(DIRTY_OPS_KEY)));
  expect(stash.tabs.Roster[0].seatEpoch).toBe(epoch);
  await swap();
  const before = await dbFingerprint();
  await page.unroute(API);
  await page.reload();
  await page.waitForFunction(old => STATE.seatEpoch > old && STATE.roster.length === 27, epoch);
  await expect(page.locator("#sync-banner")).toContainText("Old unsaved edits were discarded");
  await page.evaluate(() => retryAllDirty());
  expect(await dbFingerprint()).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem(DIRTY_OPS_KEY))).toBeNull();
});

test("an upgrade clears legacy cached edits and tells the owner they were not saved", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("cougar-data-v7",JSON.stringify({roster:[{id:"8408",name:"SYNTHETIC OBSOLETE"}]}));
    localStorage.setItem("cougar-dirty-tabs",JSON.stringify(["Roster"]));
    localStorage.setItem("cougar-dirty-ops-v1",JSON.stringify({v:1,tabs:{Roster:[{type:"upsert",row:{id:"8408",name:"SYNTHETIC OBSOLETE"}}]}}));
  });
  const before=await dbFingerprint();
  await boot(page);
  await expect(page.locator("#sync-banner")).toContainText("Old unsaved edits were discarded");
  expect(await page.evaluate(()=>localStorage.getItem("cougar-data-v7"))).toBeNull();
  expect(await page.evaluate(()=>STATE.dirty.size)).toBe(0);
  expect(await dbFingerprint()).toBe(before);
});

test("current devices can save concurrently and batched edits retain individual redacted history", async ({ page, context }) => {
  await boot(page);
  const other = await context.newPage(); await boot(other);
  await Promise.all([openBookOut(page, "8408"), openBookOut(other, "9302")]);
  await Promise.all([page.click("#f-bo-submit"), other.click("#f-bo-submit")]);
  await Promise.all([settle(page), settle(other)]);
  const saved = await sql`select id,"outOfCamp",name from roster where id in ('8408','9302') order by id`;
  expect(saved.every(r => r.outOfCamp === "true" || r.outOfCamp === "TRUE")).toBe(true);
  const all = await read();
  const result = await post({ action: "applyOps", tab: "Roster", seatEpoch: all.seatEpoch, ops: [
    { op: "upsert", row: { id: "8408", notes: "SYNTHETIC verified edit", dob: "SYNTHETIC changed DOB" } },
    { op: "upsert", row: { id: "9302", groups: "SYNTHETIC group" } },
  ] });
  expect(result.applied).toBe(2);
  const history = await sql`select row_id,before,after from audit where action='applyOps:upsert' order by row_id`;
  expect(history).toHaveLength(2);
  expect(history[0].before.dob).toBe("[redacted]");
  expect(history[0].after.dob).toBe("[changed]");
  expect(history[0].after.notes).toBe("SYNTHETIC verified edit");
  expect(history[1].after.groups).toBe("SYNTHETIC group");
  await other.close();
});

test("late enlistees join the end of three sections without renumbering existing people", async () => {
  await sql`delete from roster where id='7205'`; // A pre-existing vacancy must remain a vacancy.
  const before = (await rawRows()).map(r => [r.raw.id,r.raw.pid]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cougar-enlist-"));
  const file = path.join(dir, "synthetic.csv");
  fs.writeFileSync(file, "Name,Section,PID\nALPHA INVENTED A,72,NEW\nBRAVO INVENTED B,84,NEW\nCHARLIE INVENTED C,93,NEW\n");
  execFileSync(process.execPath, ["scripts/reseat.mjs", "--enlist", file, "--apply"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB, COUGAR_ENC_KEY: "local-dev-key" }, stdio: "pipe" });
  const after = (await rawRows()).map(r => [r.raw.id,r.raw.pid]);
  expect(after.filter(([id]) => before.some(([old]) => old === id))).toEqual(before);
  expect(after.filter(([id]) => !before.some(([old]) => old === id)).map(([id]) => id)).toEqual(["7210", "8410", "9310"]);
});

test("a verified repair restores complete profiles, preserves later edits, blocks changes and is idempotent", async ({ page }) => {
  const R = await import(pathToFileURL(path.join(ROOT, "scripts/repair-roster.mjs")));
  const ids = ["8408", "9302", "9303"];
  const original = (await rawRows()).map(r => r.raw);
  const good = new Map(original.map(r => [r.id, r]));
  // Equivalent to the three overwritten identities, with unique synthetic DOBs.
  for (const [bad, donor] of [["8408", "8409"], ["9302", "9303"], ["9303", "9304"]]) {
    await sql`update roster t set name=s.name,email=s.email,phone=s.phone,dob=s.dob from roster s where t.id=${bad} and s.id=${donor}`;
  }
  await sql`update roster set notes='SYNTHETIC valid later edit' where id='8408'`;
  const current = new Map((await rawRows()).map(r => [r.raw.id,r.raw]));
  const all = await read();
  const scopeIds = [...ids, ...original.map(r => r.id).filter(id => !ids.includes(id)).slice(0,16)];
  const incidentAt = "2026-10-07T06:59:43.709837Z";
  for (const id of scopeIds) await sql`insert into intake_log(at,intake,pid,name,old_d4,new_d4,matched_by) values (${incidentAt}::text::timestamptz,'bootstrap',${current.get(id).pid},${good.get(id).name},${id},${id},'move')`;
  const linked = await R.linkedFingerprints(sql,scopeIds);
  const people = scopeIds.map(id => ({ id, pid: current.get(id).pid, expectedFingerprint: R.fingerprint(current.get(id)),
    fieldReview: Object.fromEntries(Object.keys(current.get(id)).filter(k => !["id","4d","pid","intake","deleted_at","_pk","created_at","updated_at","extra"].includes(k)).map(k => [k, { verified: true, source: "synthetic verified source" }])),
    linkedReview: { verified: true, source: "synthetic linked-record verification", expectedFingerprint:linked.get(id) },
  }));
  const manifest = { version: 1, incidentAt, seatEpoch: all.seatEpoch, people,
    records: ids.map(id => ({ table: "roster", key: id, subjectPid: current.get(id).pid, expectedFingerprint: R.fingerprint(current.get(id)), fields: [
      ...["name","email","phone"].map(field => ({ field, value: good.get(id)[field], verified: true, source: "synthetic source" })),
      { field: "dob", value: id+'-dob', verified: true, source: "synthetic source" },
    ] })),
  };
  const incomplete = structuredClone(manifest); incomplete.people[1].fieldReview.dob.verified = false;
  const snapshot = await dbFingerprint();
  await expect(R.repair(sql,incomplete,{apply:true,checksum:R.manifestChecksum(incomplete)})).rejects.toThrow("unverified");
  expect(await dbFingerprint()).toBe(snapshot);
  const stale = structuredClone(manifest); stale.records[2].expectedFingerprint='0'.repeat(64);
  await expect(R.repair(sql,stale,{apply:true,checksum:R.manifestChecksum(stale)})).rejects.toThrow("changed");
  expect(await dbFingerprint()).toBe(snapshot);
  const preview = await R.repair(sql,manifest);
  expect(await dbFingerprint()).toBe(snapshot);
  await sql`insert into medical (id,d4,status,reason) values ('M-NEW','8408','LD','SYNTHETIC later medical event')`;
  await expect(R.repair(sql,manifest,{apply:true,checksum:preview.checksum})).rejects.toThrow("Linked history changed");
  await sql`delete from medical where id='M-NEW'`;
  expect(await dbFingerprint()).toBe(snapshot);
  const applied = await R.repair(sql,manifest,{apply:true,checksum:preview.checksum});
  expect(applied.records).toBe(3);
  const correct = await read();
  for (const id of ids) {
    const row = correct.roster.find(r => r.id===id);
    expect(row.name).toBe(good.get(id).name);
    expect(row.email).toBe(good.get(id).email);
    expect(row.dob).toBe(id+'-dob');
  }
  expect(correct.roster.find(r=>r.id==='8408').notes).toBe('SYNTHETIC valid later edit');
  expect(correct.seatEpoch).toBe(all.seatEpoch+1);
  expect(correct.medical).toEqual(all.medical);
  const final = await dbFingerprint();
  expect((await R.repair(sql,manifest,{apply:true,checksum:preview.checksum})).alreadyApplied).toBe(true);
  expect(await dbFingerprint()).toBe(final);
  await boot(page);
  for (const id of ids) await expect(page.locator("#content tbody tr").filter({ has: page.locator("td",{hasText:new RegExp(`^${id}$`)}) })).toContainText(good.get(id).name);
  expect(new Set(correct.roster.map(r=>r.name)).size).toBe(correct.roster.length);

  const V=await import(pathToFileURL(path.join(ROOT,"scripts/review-roster.mjs")));
  const report=await V.reviewIncident(sql,incidentAt,{forms:scopeIds.map(id=>({line:scopeIds.indexOf(id)+2,name:good.get(id).name,nricHash:"",fields:{email:good.get(id).email,phone:good.get(id).phone},issues:[]})),formSource:"synthetic FORMS.csv",encKey:"local-dev-key"});
  expect(report.people).toHaveLength(19);
  expect(report.review.evidence.every(e=>e.formMatch.matched)).toBe(true);
  expect(report.review.ready).toBe(false);
  expect(report.people.every(p=>/^[a-f0-9]{64}$/.test(p.linkedReview.expectedFingerprint))).toBe(true);
  const P=await import(pathToFileURL(path.join(ROOT,"scripts/review-profiles.mjs")));
  const document=await P.profileReview(sql,report,"local-dev-key");
  expect(document).toContain(syntheticName("8408"));
  expect(document).toContain("M-A");
  expect(document).toContain("Owner verification required");
});
