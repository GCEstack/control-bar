"use strict";

/*
 * BROWSER WIRING PROBE — simulates the real WebExtension background page.
 *
 * WHY THIS EXISTS: run-tests.js requires the modules via CommonJS, so the
 * `if (typeof browser !== ...)` wiring block in background/main.js is NEVER
 * executed by the acceptance suite. That coverage gap allowed a link-time
 * SyntaxError (re-declaring a global lexical binding) to ship and silently
 * kill the entire background page: no onMessage listener -> the sidebar gets
 * no reply -> it renders its static HTML with no command controls (F-DON-01).
 *
 * This probe loads the SHIPPED files in manifest.json order into ONE shared
 * vm context, which is exactly how Firefox evaluates background.scripts:
 * each file is a classic script, top-level const/let go to the shared global
 * lexical environment, and any collision throws SyntaxError at link time.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT_ROOT = path.join(__dirname, "..", "extension");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "manifest.json"), "utf8"));

function fail(msg) {
  console.log("[FAIL] R10 — Browser wiring boots: " + msg);
  process.exit(1);
  return false;
}

async function main() {
  // --- build a browser-like global environment ------------------------
  const listeners = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    _snapshot: null
  };

  sandbox.browser = {
    runtime: {
      id: "gce-don-control-bar@don.local",
      onMessage: { addListener: (fn) => listeners.push({ kind: "onMessage", fn }) },
      sendMessage: async () => undefined,
      getBrowserInfo: undefined
    },
    commands: {
      onCommand: { addListener: (fn) => listeners.push({ kind: "onCommand", fn }) }
    },
    storage: {
      local: {
        get: async (key) => ({}),
        set: async (bag) => undefined
      }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => { throw new Error("no tab"); }
    }
  };

  const ctx = vm.createContext(sandbox);

  // --- load the shipped files in manifest order as classic scripts -----
  const scripts = MANIFEST.background.scripts;
  const errors = [];
  for (const rel of scripts) {
    const file = path.join(EXT_ROOT, rel);
    const code = fs.readFileSync(file, "utf8");
    try {
      vm.runInContext(code, ctx, { filename: "extension/" + rel });
    } catch (e) {
      errors.push(rel + " -> " + e.name + ": " + e.message);
    }
  }

  // --- 1. no script may have failed to link/evaluate --------------------
  if (errors.length) {
    return fail("script failed to evaluate (background page would be dead):\n       " + errors.join("\n       "));
  }

  // --- 2. the wiring block must have engaged ----------------------------
  if (typeof ctx.__gceCore === "undefined") {
    return fail("browser wiring block did not engage: __gceCore not set. The gate is wrong or a global is missing.");
  }

  // --- 3. a message listener must be registered -------------------------
  const msgListeners = listeners.filter((l) => l.kind === "onMessage");
  if (msgListeners.length === 0) {
    return fail("no onMessage listener registered: sidebar GCE_GET_SNAPSHOT would never be answered.");
  }

  // --- 4. the listener must actually answer GCE_GET_SNAPSHOT ------------
  const reply = await msgListeners[0].fn({ type: "GCE_GET_SNAPSHOT" });
  if (!reply) return fail("GCE_GET_SNAPSHOT returned no snapshot.");
  if (!Array.isArray(reply.controls)) return fail("snapshot has no controls array: " + JSON.stringify(Object.keys(reply)));
  if (reply.controls.length !== 7) return fail("expected 7 controls, got " + reply.controls.length);

  const ids = reply.controls.map((c) => c.id).join(",");
  const expected = "RELOAD_BOOTSTRAP,RECENTER_SESSION,REASSERT_FRAME,SHOW_STATE,ANCHOR_COMMIT,CREATE_HANDOFF,END_SESSION";
  if (ids !== expected) return fail("control ids wrong: " + ids);

  // --- 5. a command listener must be registered (keyboard shortcuts) -----
  if (listeners.filter((l) => l.kind === "onCommand").length === 0) {
    return fail("no onCommand listener: Ctrl+Alt+1..7 would be dead.");
  }

  console.log("[PASS] R10 — Browser wiring boots: all " + scripts.length + " background scripts evaluated in one shared global scope");
  console.log("       onMessage listener registered and answers GCE_GET_SNAPSHOT with 7 controls (" + ids + ")");
  console.log("       onCommand listener registered (keyboard shortcuts live)");
  console.log("       __gceCore present -> wiring gate resolved the globals correctly");
  // The wiring block installs a 700ms setInterval, which keeps Node's event
  // loop alive. Exit explicitly - the probe result is already decided.
  process.exit(0);
}

main().catch((e) => {
  console.log("[FAIL] R10 — Browser wiring boots: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
