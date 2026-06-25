// In-memory stubs for the browser globals the frontend sync-core touches at load
// and runtime (localStorage, document, window, timers, performance, confirm).
// Each client gets its own instance, so two simulated tabs don't share state.
// `ctl` lets tests flip the modal-open state and the confirm() return value.

function makeBrowser() {
  const ctl = { modalOpen: false, confirm: true };

  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear()
  };

  function makeEl() {
    return {
      style: { cssText: "" }, innerHTML: "", textContent: "", title: "", onclick: null,
      classList: {
        _s: new Set(["hidden"]),
        contains(c) { return this._s.has(c); },
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }
      },
      appendChild() {}, querySelector() { return null; }
    };
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
  const window = { addEventListener() {} };

  return {
    ctl,
    globals: {
      localStorage, document, window,
      confirm: () => ctl.confirm,
      performance: { now: () => Date.now() },
      setTimeout: () => 0, clearTimeout: () => {},
      setInterval: () => 0, clearInterval: () => {}
    }
  };
}

module.exports = { makeBrowser };
