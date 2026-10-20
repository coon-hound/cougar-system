// Saves carry only the fields the user changed. Before this, editing one field
// of a man sent his whole profile as the phone last saw it, so a group tag
// quietly put back a next-of-kin number another commander had just corrected
// (and on 2026-10-11 copied whole profiles onto the wrong men).
const { suite, test, ok, eq } = require("./_tap");
const { loadBackend, makeClient } = require("./harness");

const ROSTER_HEADERS = ["id", "4d", "name", "phone", "nokPhone", "groups"];
const seedRoster = (backend) => backend.db.seed("Roster", ROSTER_HEADERS, [
  ["9302", "C9302", "JARETT", "81111111", "91111111", ""],
  ["9303", "C9303", "LEE", "82222222", "92222222", ""],
]);
const man = (c, id) => c.sb.STATE.roster.find(r => String(r.id) === id);
const posts = (c, action) => c.fetchSpy.filter(r => r.method === "POST" && (!action || r.action === action));
const sentRows = (c) => posts(c).flatMap(r =>
  r.body.action === "applyOps" ? r.body.ops.map(o => o.row).filter(Boolean) : (r.body.row ? [r.body.row] : []));

module.exports = async function run() {
  suite("sync: saves send only changed fields");

  await test("two commanders edit different fields of one man → both edits survive", async () => {
    const backend = loadBackend();
    seedRoster(backend);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();

    const b = man(B, "9302"); b.nokPhone = "99999999";            // B corrects NOK
    await B.sb.autoSync("Roster", { type: "upsert", row: b });
    const a = man(A, "9302"); a.groups = "Guard Duty";             // A, still holding the old NOK, tags him
    await A.sb.autoSync("Roster", { type: "upsert", row: a });

    const row = backend.db.rowsOf("Roster").find(r => String(r.id) === "9302");
    eq(row.nokPhone, "99999999", "B's NOK correction was not reverted by A's tag");
    eq(row.groups, "Guard Duty", "A's tag landed");
    eq(row.name, "JARETT", "untouched fields kept");
  });

  await test("a save sends only id and the changed field", async () => {
    const backend = loadBackend();
    seedRoster(backend);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;

    const a = man(A, "9303"); a.groups = "Gunnery";
    await A.sb.autoSync("Roster", { type: "upsert", row: a });
    const rows = sentRows(A);
    eq(rows.length, 1, "one row sent");
    eq(Object.keys(rows[0]).sort(), ["groups", "id"], "only id + groups on the wire");
  });

  await test("a save that changes nothing sends nothing", async () => {
    const backend = loadBackend();
    seedRoster(backend);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;

    await A.sb.autoSync("Roster", { type: "upsert", row: man(A, "9303") });
    eq(posts(A).length, 0, "no request");
  });

  await test("the server copy follows this phone's own saves", async () => {
    const backend = loadBackend();
    seedRoster(backend);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;

    const a = man(A, "9303");
    a.groups = "G1";
    await A.sb.autoSync("Roster", { type: "upsert", row: a });
    a.phone = "80000000";
    await A.sb.autoSync("Roster", { type: "upsert", row: a });
    const rows = sentRows(A);
    eq(Object.keys(rows[1]).sort(), ["id", "phone"], "second save does not resend groups");
  });

  await test("a row the server has never sent goes whole", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", ["id", "d4", "reason", "status"], []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;

    await A.sb.autoSync("Medical", { type: "upsert", row: { id: "m1", d4: "9302", reason: "Fever", status: "MC" } });
    eq(Object.keys(sentRows(A)[0]).sort(), ["d4", "id", "reason", "status"], "new row sent in full");
    eq(backend.db.rowsOf("Medical")[0].reason, "Fever", "and stored");
  });

  await test("queued changes to one row merge instead of the later one dropping the earlier", async () => {
    const A = makeClient(loadBackend());
    const out = A.sb.coalesceModes([
      { type: "upsert", seatEpoch: 1, row: { id: "9302", phone: "1" } },
      { type: "upsert", seatEpoch: 1, row: { id: "9302", groups: "G" } },
    ]);
    eq(out.length, 1, "one op");
    eq(out[0].row, { id: "9302", phone: "1", groups: "G" }, "both fields kept");
  });

  await test("after a reseat the server copy is dropped, so nothing is diffed against the old occupant", async () => {
    const backend = loadBackend();
    seedRoster(backend);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.sb.discardStaleSeating(false);
    A.fetchSpy.length = 0;

    const row = { id: "9302", "4d": "C9302", name: "JARETT", phone: "81111111", nokPhone: "91111111", groups: "X" };
    await A.sb.autoSync("Roster", { type: "upsert", row });
    eq(Object.keys(sentRows(A)[0]).sort(), Object.keys(row).sort(), "sent whole");
  });

  await test("a phone on the Apps Script backend still sends whole rows", async () => {
    const backend = loadBackend();
    seedRoster(backend);
    const A = makeClient(backend);
    A.sb.STATE.apiUrl = "https://script.google.com/macros/s/TEST/exec";
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;

    const a = man(A, "9303"); a.groups = "Gunnery";
    await A.sb.autoSync("Roster", { type: "upsert", row: a });
    ok(Object.keys(sentRows(A)[0]).includes("nokPhone"), "whole row sent");
  });

  await test("Sheets upsertRow with a partial row keeps the cells it was not sent", async () => {
    const backend = loadBackend();
    seedRoster(backend);
    const res = backend.upsertRow("Roster", { id: "9302", groups: "Gunnery" });
    ok(res.ok, "updated");
    const row = backend.db.rowsOf("Roster").find(r => String(r.id) === "9302");
    eq(row.groups, "Gunnery", "sent field written");
    eq(row.nokPhone, "91111111", "unsent field kept");
    eq(row.name, "JARETT", "name kept");
  });
};
