// In-memory mock of the Google Apps Script services the sync backend uses, with
// a faithful-enough Sheets model (a sheet = 2-D grid, row 0 = headers) so the
// REAL apps-script-Code.gs read/write/lock/rev functions run unmodified.
//
// makeGoogle() returns { services, db }:
//   services — the globals injected into the backend sandbox (SpreadsheetApp, …)
//   db       — test helpers: seed(tab,headers,rows), rowsOf(tab), props, spy

function makeGoogle() {
  const props = new Map();        // ScriptProperties
  const sheets = new Map();       // name -> { name, grid: any[][] }
  const spy = { getDisplayValues: 0, getValues: 0 };

  function makeRange(sheet, r, c, nr, nc) {
    return {
      getValues() {
        spy.getValues++;
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sheet.grid[r - 1 + i] || [];
          const o = [];
          for (let j = 0; j < nc; j++) {
            const v = row[c - 1 + j];
            o.push(v === undefined ? "" : v);
          }
          out.push(o);
        }
        return out;
      },
      getDisplayValues() {
        spy.getDisplayValues++;
        return this.getValues().map(row => row.map(v =>
          v instanceof Date ? "DISP(" + v.getTime() + ")" : (v === "" || v == null ? "" : String(v))
        ));
      },
      setValues(vals) {
        for (let i = 0; i < vals.length; i++) {
          const ri = r - 1 + i;
          while (sheet.grid.length <= ri) sheet.grid.push([]);
          const row = sheet.grid[ri];
          for (let j = 0; j < (vals[i] ? vals[i].length : 0); j++) {
            const ci = c - 1 + j;
            while (row.length <= ci) row.push("");
            row[ci] = vals[i][j];
          }
        }
        return this;
      },
      setFontWeight() { return this; }
    };
  }

  function makeSheet(sheet) {
    return {
      getName() { return sheet.name; },
      getLastRow() { return sheet.grid.length; },
      getLastColumn() { return sheet.grid.reduce((m, row) => Math.max(m, row.length), 0); },
      getRange(r, c, nr, nc) {
        return makeRange(sheet, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc);
      },
      getDataRange() {
        return makeRange(sheet, 1, 1, Math.max(1, sheet.grid.length), Math.max(1, this.getLastColumn()));
      },
      appendRow(arr) { sheet.grid.push(arr.slice()); return this; },
      deleteRow(i) { sheet.grid.splice(i - 1, 1); return this; },
      clear() { sheet.grid = []; return this; },
      setFrozenRows() { return this; }
    };
  }

  const spreadsheet = {
    getName() { return "MockSheet"; },
    getSheetByName(n) { const s = sheets.get(n); return s ? makeSheet(s) : null; },
    getSheets() { return [...sheets.values()].map(makeSheet); },
    insertSheet(n) { const s = { name: n, grid: [] }; sheets.set(n, s); return makeSheet(s); }
  };

  const scriptProps = {
    getProperty: k => (props.has(k) ? props.get(k) : null),
    setProperty: (k, v) => { props.set(k, String(v)); return scriptProps; },
    getProperties: () => { const o = {}; props.forEach((v, k) => (o[k] = v)); return o; },
    deleteProperty: k => { props.delete(k); return scriptProps; }
  };

  const services = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    PropertiesService: { getScriptProperties: () => scriptProps },
    LockService: { getScriptLock: () => ({ waitLock: () => true, tryLock: () => true, releaseLock: () => {} }) },
    Session: {
      getScriptTimeZone: () => "Asia/Singapore",
      getEffectiveUser: () => ({ getEmail: () => "test@example.com" }),
      getActiveUser: () => ({ getEmail: () => "test@example.com" })
    },
    Utilities: {
      formatDate: (d, tz, fmt) => (fmt === "HH:mm" ? "07:30" : "01 Jan 2026"),
      getUuid: () => "uuid-" + Math.random().toString(36).slice(2),
      newBlob: () => ({}),
      base64Decode: () => []
    },
    ContentService: {
      createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }),
      MimeType: { JSON: "json" }
    },
    Logger: { log() {} },
    // Stubs for services the sync paths never invoke (present so incidental refs
    // in unrelated branches don't ReferenceError if ever reached).
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger() {},
      newTrigger: () => ({ forSpreadsheet: () => ({ onEdit: () => ({ create() {} }) }) })
    },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail() {} },
    UrlFetchApp: { fetch: () => ({ getContentText: () => "{}", getResponseCode: () => 200 }) }
  };

  const db = {
    seed(tab, headers, rows) {
      sheets.set(tab, { name: tab, grid: [headers.slice(), ...(rows || []).map(r => r.slice())] });
    },
    // Data rows of a tab as objects keyed by header — for assertions.
    rowsOf(tab) {
      const s = sheets.get(tab);
      if (!s || s.grid.length < 2) return [];
      const h = s.grid[0];
      return s.grid.slice(1).map(r => { const o = {}; h.forEach((k, i) => (o[k] = r[i])); return o; });
    },
    hasSheet(tab) { return sheets.has(tab); },
    setProp(k, v) { props.set(k, String(v)); },
    getProp(k) { return props.has(k) ? props.get(k) : null; },
    spy
  };

  return { services, db };
}

module.exports = { makeGoogle };
