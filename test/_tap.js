// Minimal zero-dependency test runner shared by every *.test.js file.
// Tests run sequentially (await each) so scenarios that share a backend stay
// deterministic. A test "passes" unless its function throws / rejects.
let _pass = 0, _fail = 0;
const _failed = [];

function suite(name) { console.log("\n# " + name); }

async function test(name, fn) {
  try {
    await fn();
    _pass++;
    console.log("  ok   - " + name);
  } catch (e) {
    _fail++;
    _failed.push(name);
    console.log("  FAIL - " + name);
    console.log("         " + String((e && e.stack) || e).split("\n").join("\n         "));
  }
}

function ok(cond, msg) { if (!cond) throw new Error("expected truthy" + (msg ? " — " + msg : "")); }
function eq(actual, expected, msg) {
  const A = JSON.stringify(actual), B = JSON.stringify(expected);
  if (A !== B) throw new Error((msg ? msg + " — " : "") + "expected " + B + " but got " + A);
}
function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error("expected to throw" + (msg ? " — " + msg : ""));
}

function summary() {
  console.log("\n" + _pass + " passed, " + _fail + " failed");
  return _fail;
}

module.exports = { suite, test, ok, eq, throws, summary };
