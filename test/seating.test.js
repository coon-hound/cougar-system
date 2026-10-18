const { suite, test, eq, ok } = require("./_tap");
const { loadBackend, makeClient } = require("./harness");
const { pathToFileURL } = require("url");
const path = require("path");

module.exports = async () => {
  suite("seating: queued edits keep the seating in which they were created");
  await test("a failed edit retains its epoch through persistence and reload", async () => {
    const server = loadBackend();
    const a = makeClient(server);
    a.sb.STATE.seatEpoch = 7;
    a.sb.STATE.roster = [{ id: "5101", name: "ALPHA SYNTHETIC" }];
    a.sb.saveLocal();
    a.intercept = rec => rec.method === "POST" ? { error: "temporarily unavailable" } : null;
    await a.sb.autoSync("Roster", { type: "upsert", row: a.sb.STATE.roster[0] });
    const saved = JSON.parse(a.store.get("cougar-dirty-ops-v1"));
    eq(saved.tabs.Roster[0].seatEpoch, 7);
    const b = makeClient(server, { store: a.store });
    b.sb.loadLocal();
    b.sb.STATE.seatEpoch = 8; // Updating STATE must never retag the queued operation.
    b.intercept = rec => rec.method === "POST" ? { error: "temporarily unavailable" } : null;
    await b.sb.retryAllDirty();
    eq(b.fetchSpy.find(r => r.method === "POST").body.seatEpoch, 7);
  });
  await test("batches never combine two different seating versions", () => {
    const a = makeClient(loadBackend());
    const q = [
      { type: "upsert", row: { id: "5101" }, seatEpoch: 1 },
      { type: "upsert", row: { id: "5102" }, seatEpoch: 2 },
    ];
    eq(a.sb.takeBatch(q).seatEpoch, 1);
    eq(q.length, 1);
  });
  await test("an enqueued row is a snapshot, not a mutable STATE reference", async () => {
    const a = makeClient(loadBackend());
    a.sb.STATE.seatEpoch = 1;
    const row = { id: "5101", name: "ALPHA SYNTHETIC" };
    const pending = a.sb.autoSync("Roster", { type: "upsert", row });
    row.name = "BRAVO SYNTHETIC";
    await pending;
    eq(a.fetchSpy.find(r => r.method === "POST").body.row.name, "ALPHA SYNTHETIC");
  });
  await test("a seating rejection cannot fall back to a full replacement", async () => {
    const a = makeClient(loadBackend());
    a.sb.STATE.seatEpoch = 1;
    a.intercept = rec => {
      if (rec.method === "POST") return { error: "reload", reason: "SEATING_CHANGED", code: 409, seatEpoch: 2 };
      if (rec.action === "readAll") return { roster: [{ id: "5101", name: "BRAVO SYNTHETIC" }], revs: { Roster: 2 }, seatEpoch: 2 };
    };
    await a.sb.autoSync("Roster", { type: "upsert", row: { id: "5101", name: "ALPHA SYNTHETIC" } });
    eq(a.fetchSpy.filter(r => r.method === "POST").length, 1);
    eq(a.sb.STATE.roster[0].name, "BRAVO SYNTHETIC");
    eq(a.sb.STATE.dirty.size, 0);
    eq(a.sb.__sync.dirtyOps.size, 0);
    eq(a.sb.__sync.lastConflictedReplace, null);
    eq(a.sb.__sync.retryTimer, null);
  });
  await test("a seating transition discovered during conflict recovery never reapplies the old row", async () => {
    const a = makeClient(loadBackend());
    a.sb.STATE.seatEpoch=1;
    a.intercept = rec => {
      if (rec.method==="POST") return {conflict:true,serverRev:2};
      if (rec.action==="read") return {rows:[{id:"5101",name:"BRAVO SYNTHETIC"}],rev:2,seatEpoch:2};
      if (rec.action==="readAll") return {roster:[{id:"5101",name:"BRAVO SYNTHETIC"}],revs:{Roster:2},seatEpoch:2};
    };
    await a.sb.autoSync("Roster",{type:"upsert",row:{id:"5101",name:"ALPHA SYNTHETIC"}});
    eq(a.fetchSpy.filter(r=>r.method==="POST").length,1);
    eq(a.sb.STATE.roster[0].name,"BRAVO SYNTHETIC");
  });

  suite("repair manifest: full verification and explicit identity");
  const R = await import(pathToFileURL(path.join(__dirname, "../scripts/repair-roster.mjs")));
  const manifest = () => ({
    version: 1, seatEpoch: 1, incidentAt: "2026-10-07T00:00:00Z",
    people: [{ id: "5101", pid: "P-SYNTHETIC", expectedFingerprint: "a".repeat(64), fieldReview: { name: { verified: true, source: "synthetic roll" } }, linkedReview: { verified: true, source: "synthetic history", expectedFingerprint:"b".repeat(64) } }],
    records: [{ table: "roster", key: "5101", subjectPid: "P-SYNTHETIC", expectedFingerprint: "a".repeat(64), fields: [{ field: "name", value: "ALPHA SYNTHETIC", verified: true, source: "synthetic roll" }] }],
  });
  await test("an unverified field or linked-history review blocks the whole manifest", () => {
    for (const alter of [m => m.people[0].linkedReview.verified = false, m => m.people[0].fieldReview.name.verified = false, m => m.records[0].fields[0].verified = false]) {
      const m = manifest(); alter(m);
      let error; try { R.validateManifest(m); } catch (e) { error = e; }
      ok(error);
    }
  });
  await test("a repair cannot change a roster seat or person ID", () => {
    const m = manifest(); m.records[0].fields[0].field = "pid";
    let error; try { R.validateManifest(m); } catch (e) { error = e; }
    ok(error);
  });
  await test("manifest fingerprints are deterministic but change with data", () => {
    eq(R.fingerprint({ b: 2, a: 1 }), R.fingerprint({ a: 1, b: 2 }));
    ok(R.fingerprint({ name: "ALPHA" }) !== R.fingerprint({ name: "BRAVO" }));
    const m = manifest(); const old = R.manifestChecksum(m);
    m.records[0].fields[0].source = "another source";
    ok(old !== R.manifestChecksum(m));
  });

  suite("Forms matching: approximate names cannot swap sensitive profiles");
  const F = await import(pathToFileURL(path.join(__dirname, "../scripts/forms-match.mjs")));
  await test("reordered exact name tokens match, but duplicate exact names remain unresolved", () => {
    const forms=[{line:2,name:"TAN WEI MING",nricHash:"",fields:{},issues:[]}];
    eq(F.matchForms({name:"WEI MING TAN"},forms).method,"exact-name");
    eq(F.matchForms({name:"WEI MING TAN"},[...forms,{...forms[0],line:3}]).matched,false);
  });
  await test("a fuzzy spelling needs corroboration; conflicting NRICs cannot match by name", () => {
    const form={line:2,name:"TAN WEI MING",nricHash:"synthetic-digest-a",fields:{},issues:[]};
    eq(F.matchForms({name:"TAN WEI MIN"},[form]).matched,false);
    eq(F.matchForms({name:"TAN WEI MIN",nricHash:"synthetic-digest-a"},[form]).method,"nric");
    eq(F.matchForms({name:"TAN WEI MING",nricHash:"synthetic-digest-b"},[form]).matched,false);
  });
  await test("invalid and ambiguous dates are blocked instead of silently rewritten", () => {
    eq(F.formDob("31022006"),null);
    eq(F.formDob("1012006"),null);
    eq(F.formDob("18012006"),"18 Jan 2006");
    eq(F.formDob("18/01/2006"),"18 Jan 2006");
  });
};
