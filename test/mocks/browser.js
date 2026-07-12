// In-memory stubs for the browser globals the frontend sync-core touches at load
// and runtime (localStorage, document, window, timers, performance, confirm,
// navigator, AbortController). Each client gets its own instance unless a test
// passes opts.store to share localStorage (simulates a reload on one device).
// `ctl` lets tests flip the modal-open state, the confirm() return value, the
// online/offline state, and drive the FAKE timer queue.
//
// Timers are a fake queue: nothing ever fires on its own (existing tests keep
// their no-op semantics), a test fires them explicitly via ctl.timers:
//   pending()          → count of armed timers
//   next()             → fire ONLY the earliest timer, then drain microtasks
//   advance(ms)        → fire everything due within the next ms of fake time
//   flush(maxRounds)   → fire until quiet (intervals fire ONCE then drop, so a
//                        repaint interval can't spin this forever)
//   log                → [{ delay, at }] of every setTimeout ever armed - lets
//                        tests assert backoff growth without a fake clock
// Firing awaits a macrotask turn between shots so promise chains resolved by a
// timer fully settle (and may arm the next timer) before the queue re-scans.

function makeBrowser(opts) {
  opts = opts || {};
  const ctl = { modalOpen: false, confirm: true };

  const store = opts.store || new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear()
  };

  function makeEl() {
    const el = {
      style: { cssText: "" }, textContent: "", title: "", onclick: null,
      className: "", dataset: {}, children: [],
      classList: {
        _s: new Set(["hidden"]),
        contains(c) { return this._s.has(c); },
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }
      },
      appendChild(c) { el.children.push(c); return c; },
      querySelector() { return null; }
    };
    // Setting markup replaces children, like a real element (the sync banner
    // does `innerHTML = ""` then appendChild - tests assert on children).
    let html = "";
    Object.defineProperty(el, "innerHTML", {
      get() { return html; },
      set(v) { html = v; el.children.length = 0; }
    });
    return el;
  }
  const els = {};
  const document = {
    getElementById(id) {
      const e = els[id] || (els[id] = makeEl());
      if (id === "modal-overlay") { if (ctl.modalOpen) e.classList.remove("hidden"); else e.classList.add("hidden"); }
      return e;
    },
    createElement() { return makeEl(); },
    body: { appendChild() {} },
    addEventListener() {},
    visibilityState: "visible"
  };
  // Direct element access for assertions (e.g. the sync banner's children).
  ctl.getEl = id => document.getElementById(id);

  // window event listeners are captured so ctl.setOnline can fire them.
  const winListeners = {};
  const window = {
    addEventListener(ev, fn) { (winListeners[ev] || (winListeners[ev] = [])).push(fn); }
  };

  const navigator = { onLine: true };
  ctl.setOnline = on => {
    navigator.onLine = !!on;
    for (const fn of winListeners[on ? "online" : "offline"] || []) fn();
  };

  // ── Fake timer queue ────────────────────────────────────
  let fakeNow = 0;
  let timerSeq = 0;
  const timerQ = new Map();   // id → { at, fn, every }
  const timerLog = [];        // every setTimeout armed: { delay, at }
  function setTimeout(fn, ms) {
    const id = ++timerSeq;
    const delay = Number(ms) || 0;
    timerQ.set(id, { at: fakeNow + delay, fn });
    timerLog.push({ delay, at: fakeNow + delay });
    return id;
  }
  function clearTimeout(id) { timerQ.delete(id); }
  function setInterval(fn, ms) {
    const id = ++timerSeq;
    const every = Number(ms) || 0;
    timerQ.set(id, { at: fakeNow + every, fn, every });
    return id;
  }
  function clearInterval(id) { timerQ.delete(id); }

  // A macrotask turn: all queued microtasks (whole await-chains) run first.
  const turn = () => new Promise(r => setImmediate(r));
  function earliest() {
    let best = null;
    for (const [id, t] of timerQ) if (!best || t.at < best[1].at) best = [id, t];
    return best;
  }
  ctl.timers = {
    log: timerLog,
    pending() { return timerQ.size; },
    async next() {
      await turn();
      const e = earliest();
      if (!e) return false;
      const [id, t] = e;
      fakeNow = Math.max(fakeNow, t.at);
      if (t.every) t.at = fakeNow + t.every; else timerQ.delete(id);
      t.fn();
      await turn();
      return true;
    },
    async advance(ms) {
      await turn();
      const target = fakeNow + ms;
      for (;;) {
        const e = earliest();
        if (!e || e[1].at > target) break;
        const [id, t] = e;
        fakeNow = Math.max(fakeNow, t.at);
        if (t.every) t.at = fakeNow + t.every; else timerQ.delete(id);
        t.fn();
        await turn();
      }
      fakeNow = target;
    },
    async flush(maxRounds) {
      await turn();
      let rounds = 0;
      const cap = maxRounds || 1000;
      while (timerQ.size && rounds++ < cap) {
        const [id, t] = earliest();
        fakeNow = Math.max(fakeNow, t.at);
        timerQ.delete(id);   // intervals fire once then drop - flush must terminate
        t.fn();
        await turn();
      }
    }
  };

  // Tiny AbortController fake: abort() flips the flag and fires listeners.
  // The harness's fetchImpl never rejects on abort itself - _fetchJson's
  // timeout path is exercised by firing the fake timer that calls abort()
  // while a test-injected fetch is held open.
  class AbortSignal {
    constructor() { this.aborted = false; this._ls = []; }
    addEventListener(ev, fn) { if (ev === "abort") this._ls.push(fn); }
    removeEventListener(ev, fn) { this._ls = this._ls.filter(f => f !== fn); }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort() {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      for (const fn of this.signal._ls.slice()) fn();
    }
  }

  return {
    ctl,
    store,
    globals: {
      localStorage, document, window, navigator, AbortController,
      confirm: () => ctl.confirm,
      performance: { now: () => Date.now() },
      setTimeout, clearTimeout, setInterval, clearInterval
    }
  };
}

module.exports = { makeBrowser };
