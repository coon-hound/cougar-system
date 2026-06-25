// Full-stack in-memory harness: loads the REAL Apps Script backend and the REAL
// frontend sync-core into one Node process, wired through a mock fetch — so a
// test can drive multiple simulated browser tabs against one server.
//
//   const backend = loadBackend();          // real apps-script-Code.gs
//   const A = makeClient(backend);          // real state.js + api.js + sync.js
//   const B = makeClient(backend);          // a second tab on the same server
//
// Frontend sync-core uses top-level `const` (STATE, API, TAB_TO_STATE) which —
// unlike browser <script> tags — does NOT cross separate vm.runInContext calls.
// So we concatenate the three files into ONE script (faithfully reproducing the
// browser's shared global scope) and expose the consts via a small epilogue.

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { makeGoogle } = require("./mocks/google");
const { makeBrowser } = require("./mocks/browser");

const ROOT = path.resolve(__dirname, "..");
const GS_PATH = path.join(ROOT, "apps-script-Code.gs");
const FRONTEND_FILES = ["js/state.js", "js/api.js", "js/sync.js"];
const VALID_TOKEN = "testtoken";

function loadBackend() {
  const { services, db } = makeGoogle();
  const sandbox = Object.assign({
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, RegExp,
    isNaN, parseInt, parseFloat
  }, services);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(GS_PATH, "utf8"), sandbox, { filename: "apps-script-Code.gs" });
  db.setProp("auth:" + VALID_TOKEN, "1");   // a valid auth token for clients
  sandbox.db = db;                          // test helpers (seed/rowsOf/spy/props)
  return sandbox;
}

function parseQuery(url) {
  const u = new URL(url);
  return {
    action: u.searchParams.get("action") || "",
    tab: u.searchParams.get("tab") || "",
    auth: u.searchParams.get("auth") || ""
  };
}

function makeClient(backend, opts) {
  opts = opts || {};
  const browser = makeBrowser();
  const fetchSpy = [];   // [{ method, action, tab }]

  async function fetchImpl(url, init) {
    const method = (init && init.method ? init.method : "GET").toUpperCase();
    let out, rec;
    if (method === "GET") {
      const q = parseQuery(url);
      rec = { method: "GET", action: q.action, tab: q.tab };
      out = backend.doGet({ parameter: { action: q.action, tab: q.tab, auth: q.auth } });
    } else {
      const body = JSON.parse(init.body);
      rec = { method: "POST", action: body.action, tab: body.tab };
      out = backend.doPost({ parameter: {}, postData: { contents: init.body } });
    }
    fetchSpy.push(rec);
    const text = out.getContent();
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  }

  // Quiet console for the client so sync.js's "[sync] …" timing logs don't spam
  // test output; errors still surface.
  const quietConsole = { log() {}, info() {}, warn() {}, table() {}, error: console.error.bind(console) };

  const sandbox = Object.assign({
    console: quietConsole, JSON, Math, Date, String, Number, Array, Object, Boolean, Set, Map, RegExp, Promise,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, URL,
    fetch: fetchImpl,
    render: () => {},                 // stub (render.js not loaded); sync guards most calls
  }, browser.globals);
  vm.createContext(sandbox);

  // Concatenate the three frontend files + an epilogue exposing the consts.
  const src = FRONTEND_FILES.map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n")
    + "\n;this.STATE = STATE; this.API = API; this.TAB_TO_STATE = TAB_TO_STATE;\n";
  vm.runInContext(src, sandbox, { filename: "frontend-bundle.js" });

  sandbox.STATE.authToken = opts.authToken || VALID_TOKEN;
  sandbox.STATE.apiUrl = "https://mock.local/exec";

  return { sb: sandbox, fetchSpy, ctl: browser.ctl, db: backend.db };
}

// Convenience: pull a client to a clean baseline (full readAll → STATE.rev set).
async function baseline(client) {
  await client.sb.API.pullAll();
  client.fetchSpy.length = 0;   // reset spy after baseline so scenario asserts are clean
}

module.exports = { loadBackend, makeClient, baseline, VALID_TOKEN, ROOT, FRONTEND_FILES };
