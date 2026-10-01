"use strict";

/*
 * SENDER PROBE (F-L-06) — GCE_ISSUE must be refused from a foreign extension.
 *
 * Same technique as browser-wiring-probe.js: the SHIPPED manifest script list is
 * evaluated in manifest order into ONE shared vm scope, which is how the host
 * evaluates a background page. The message listener is then called twice with
 * the same GCE_ISSUE payload and two different sender identities.
 *
 * Run: node test/sender-probe.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT_ROOT = path.join(__dirname, "..", "extension");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "manifest.json"), "utf8"));
const OWN_ID = MANIFEST.browser_specific_settings.gecko.id;
const FOREIGN_ID = "not-the-gce-control-bar@example.invalid";

(async () => {
  const listeners = [];
  const timers = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.push(h); return h; },
    clearInterval,
    browser: {
      runtime: {
        id: OWN_ID,
        onMessage: { addListener: (fn) => listeners.push({ kind: "onMessage", fn }) },
        sendMessage: async () => undefined
      },
      commands: { onCommand: { addListener: (fn) => listeners.push({ kind: "onCommand", fn }) } },
      storage: { local: { get: async () => ({}), set: async () => undefined } },
      tabs: { query: async () => [], sendMessage: async () => { throw new Error("no tab"); } }
    }
  };
  const ctx = vm.createContext(sandbox);

  for (const rel of MANIFEST.background.scripts) {
    vm.runInContext(fs.readFileSync(path.join(EXT_ROOT, rel), "utf8"), ctx, { filename: "extension/" + rel });
  }
  for (const h of timers) clearInterval(h);

  const msg = listeners.filter((l) => l.kind === "onMessage")[0];
  if (!msg) {
    console.log("[FAIL] R16 - no onMessage listener registered");
    process.exit(1);
  }

  const payload = { type: "GCE_ISSUE", commandId: "SHOW_STATE", seat: "CODA" };
  const own = await msg.fn(payload, { id: OWN_ID });
  const foreign = await msg.fn(payload, { id: FOREIGN_ID });
  const noSender = await msg.fn(payload, undefined);

  const out = {
    own_ok: own && own.ok === true,
    own_topState: own && own.topState,
    own_reason: own && own.reason,
    own_nonce: !!(own && own.nonce),
    foreign_ok: foreign && foreign.ok === true,
    foreign_reason: foreign && foreign.reason,
    foreign_nonce: !!(foreign && foreign.nonce),
    noSender_ok: noSender && noSender.ok === true,
    noSender_reason: noSender && noSender.reason
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
})().catch((e) => {
  console.error("[FAIL] R16 - " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
