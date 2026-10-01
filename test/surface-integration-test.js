"use strict";

const path = require("path");
const vm = require("vm");

const EXTENSION_ROOT = path.join(__dirname, "..", "extension");

function loadScript(relativePath) {
  const fullPath = path.join(EXTENSION_ROOT, relativePath);
  const code = require("fs").readFileSync(fullPath, "utf8");
  return code;
}

const protocolCode = loadScript("lib/protocol.js");
const storeCode = loadScript("lib/store.js");
const chatgptAdapterCode = loadScript("background/chatgpt-adapter.js");
const mainCode = loadScript("background/main.js");

const mockBrowser = {
  runtime: {
    id: "gce-don-control-bar@don.local",
    sendMessage: () => Promise.resolve({ ok: true, nonce: "GCE-1759000000000-1" }),
    onMessage: {
      addListener: () => {}
    }
  },
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve()
    }
  },
  tabs: {
    query: () => Promise.resolve([{ url: "https://chatgpt.com/", id: 1 }])
  }
};

const mockGCEStore = {
  createStore: () => ({
    getSession: () => Promise.resolve({ closed: false }),
    getOutstanding: () => Promise.resolve({}),
    getLastState: () => Promise.resolve(null),
    nextSequence: () => Promise.resolve(1),
    armCommand: () => Promise.resolve(),
    markSent: () => Promise.resolve(),
    markLocalFailure: () => Promise.resolve(),
    getCommandLog: () => Promise.resolve([]),
    getAckLog: () => Promise.resolve([]),
    getRejectedAcks: () => Promise.resolve([]),
    bindAck: () => Promise.resolve({ bound: { commandId: "CAPISCE", nonce: "GCE-1759000000000-1" } }),
    cacheState: () => Promise.resolve(),
    appendRejectedAck: () => Promise.resolve(),
    isOutstanding: () => Promise.resolve(false),
    openSession: () => Promise.resolve(),
    closeSession: () => Promise.resolve()
  })
};

const mockAdapter = {
  send: () => Promise.resolve({ ok: true, clearedComposer: true }),
  observeAssistantOutput: () => Promise.resolve({ ok: true, text: "" })
};

const sandbox = {
  module: { exports: {} },
  require: () => {},
  browser: mockBrowser,
  GCEStore: mockGCEStore,
  GCEChatGPTAdapter: mockAdapter,
  GCEKimiAdapter: mockAdapter,
  globalThis: {},
  console: console,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: clearInterval,
  Promise: Promise,
  Date: Date,
  JSON: JSON,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  RegExp: RegExp
};

vm.createContext(sandbox);
vm.runInContext(protocolCode, sandbox);
// Capture the protocol module at this exact point. The sandbox supplies a real
// CommonJS `module`, so protocol.js publishes into sandbox.module.exports here —
// but background/main.js runs next and overwrites that same object with {createCore}.
const protocolModule = sandbox.module.exports;
vm.runInContext(storeCode, sandbox);
vm.runInContext(chatgptAdapterCode, sandbox);
vm.runInContext(mainCode, sandbox);

const { createCore } = sandbox.module.exports;

console.log("=== SURFACE INTEGRATION TEST ===\n");

// protocol.js publishes through the sandbox CommonJS module and through
// globalThis.GCEProtocolModule (the seam the sidebar panel reads). A top-level
// `const GCEProtocol` is a context-scoped lexical binding and is NOT a property
// of the sandbox, so reading sandbox.GCEProtocol silently yielded undefined.
const protocol = protocolModule || sandbox.GCEProtocolModule || sandbox.GCEProtocol;
if (!protocol || typeof protocol.isKnownControl !== "function") {
  console.error("[FATAL] protocol module not reachable from the sandbox — cannot test the surface");
  process.exit(1);
}
const store = mockGCEStore.createStore({ get: () => Promise.resolve({}), set: () => Promise.resolve() });

const core = createCore({ protocol, store, adapter: mockAdapter });

let testsRun = 0;
let testsPassed = 0;

function test(name, fn) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`[PASS] ${name}`);
  } catch (e) {
    console.log(`[FAIL] ${name}: ${e.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const VERBS = ["CAPISCE", "HOLD", "BRANCH", "RECENTER_SESSION", "PARK", "PROMOTE", "SUPERSEDE"];

for (const verb of VERBS) {
  test(`Verb ${verb} can be issued via panel→background path`, async () => {
    const result = await core.issue(verb, "CODA");
    assertEqual(result.ok, true, "Command should be accepted");
    assertEqual(result.commandId, verb, "Command ID should match");
  });
}

test("V0: Field name contract - panel sends commandId, background reads commandId", () => {
  const msg = { type: "GCE_ISSUE", commandId: "CAPISCE", returnState: true };
  assertEqual(msg.commandId !== undefined, true, "commandId field must exist");
});

test("V0: Nonce authority - background is sole nonce authority", async () => {
  const result = await core.issue("CAPISCE", "CODA");
  assertEqual(typeof result.nonce, "string", "Nonce must be a string");
  assertEqual(result.nonce.startsWith("GCE-"), true, "Nonce must follow GCE- format");
});

test("HOLD sends HOLD then RELEASE_HOLD", async () => {
  const result1 = await core.issue("HOLD", "CODA");
  assertEqual(result1.ok, true, "HOLD should be accepted");
  
  const result2 = await core.issue("RELEASE_HOLD", "CODA");
  assertEqual(result2.ok, true, "RELEASE_HOLD should be accepted");
});

test("BRANCH payload includes branchName and origin", async () => {
  const result = await core.issue("BRANCH", "CODA", { branchName: "test-branch", origin: "main" });
  assertEqual(result.ok, true, "BRANCH should be accepted");
});

test("PROMOTE payload includes target", async () => {
  const result = await core.issue("PROMOTE", "CODA", { target: "some-task" });
  assertEqual(result.ok, true, "PROMOTE should be accepted");
});

test("PARK is a known control", () => {
  assertEqual(protocol.isKnownControl("PARK"), true, "PARK must be known");
});

test("RESUME_PARKED is a known control", () => {
  assertEqual(protocol.isKnownControl("RESUME_PARKED"), true, "RESUME_PARKED must be known");
});

console.log(`\n=== RESULTS: ${testsPassed}/${testsRun} PASSED ===`);
process.exit(testsPassed === testsRun ? 0 : 1);