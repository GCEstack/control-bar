"use strict";

/*
 * GCE Don Control Bar — headless test harness.
 *
 * Runs the SHIPPED core (lib/protocol.js, lib/store.js, background/main.js
 * factory) unmodified under Node. Only two things are substituted:
 *   - storage backend  -> in-memory map implementing get/set (same contract)
 *   - ChatGPT adapter  -> FakeAdapter (records sent envelopes; the test
 *                         supplies ACK text to feed the core's ingest)
 *
 * This proves the emitter + ACK-binding + state-cache + lifecycle logic
 * against the frozen protocol, independent of ChatGPT's DOM.
 */

const path = require("node:path");
const protocol = require(path.join(__dirname, "..", "..", "extension", "lib", "protocol.js"));
const storeFactory = require(path.join(__dirname, "..", "..", "extension", "lib", "store.js"));
const { createCore } = require(path.join(__dirname, "..", "..", "extension", "background", "main.js"));

function memBackend() {
  const map = new Map();
  return {
    async get(key) {
      const out = {};
      if (map.has(key)) out[key] = map.get(key);
      return out;
    },
    async set(bag) {
      for (const k of Object.keys(bag)) map.set(k, bag[k]);
    },
    _dump: () => Object.fromEntries(map)
  };
}

/*
 * Fake ChatGPT adapter.
 *
 * It models a COMPOSER, not just a boolean, because that is the transport
 * contract as of CB-02: a send is only ok when the composer was empty going in
 * AND verifiably cleared coming out. `adapter.composer` is directly settable so
 * a test can stage Don's unsent draft, and `clearsOnSend:false` models a send
 * control that does not accept the message.
 *
 * `failSend` forces a transport failure -> exercises FAILED_NOT_SENT.
 */
function makeFakeAdapter(opts) {
  opts = opts || {};
  const sent = [];
  const api = {
    sent,
    failSend: false,
    composer: {
      text: opts.draft !== undefined ? opts.draft : "",
      clearsOnSend: opts.clearsOnSend !== false
    },
    async send({ envelope, nonce, commandId }) {
      if (api.failSend) {
        return { ok: false, error: "FAKE_ADAPTER_INJECTED_FAILURE", composerMutated: false, draftPreserved: true, draftLength: null };
      }
      // CB-02 gate 2: Don's unsent text is never overwritten.
      if (String(api.composer.text).trim() !== "") {
        return {
          ok: false, error: "COMPOSER_OCCUPIED", disposition: "FAILED_NOT_SENT",
          composerMutated: false, draftPreserved: true, draftLength: api.composer.text.length
        };
      }
      // CB-02 gate 3: no usable send control.
      if (!api.composer.clearsOnSend) {
        // The page accepted the text but the send control did nothing, so the
        // envelope is left staged. That is a failure, not a pending send.
        api.composer.text = envelope;
        return {
          ok: false, error: "SEND_NOT_CONFIRMED", disposition: "FAILED_NOT_SENT", method: "button-click",
          clearedComposer: false, composerMutated: true, draftPreserved: true, draftLength: 0
        };
      }
      api.composer.text = "";
      sent.push({ envelope, nonce, commandId });
      return {
        ok: true, method: "fake", clearedComposer: true,
        composerMutated: true, draftPreserved: true, draftLength: 0
      };
    },
    async observeAssistantOutput() {
      return { ok: true, text: "", turnCount: 0 };
    }
  };
  return api;
}

function makeCore(opts = {}) {
  const backend = memBackend();
  const store = storeFactory.createStore(backend);
  const adapter = makeFakeAdapter(opts.adapter);
  const core = createCore({ protocol, store, adapter, sentTimeoutMs: opts.sentTimeoutMs });
  return { core, store, adapter, backend };
}

/* Build a well-formed ACK block exactly as Coda would (spec §8 delimiters). */
function ack({ cmd, nonce, result, note, state }) {
  let s = "[GCE-ACK v1]\n";
  s += "CMD: " + cmd + "\n";
  s += "NONCE: " + nonce + "\n";
  s += "RESULT: " + result + "\n";
  s += "NOTE: " + (note || "") + "\n";
  if (state) {
    s += "STATE:\n";
    for (const k of Object.keys(state)) s += k + ": " + state[k] + "\n";
  }
  s += "[/GCE-ACK]";
  return s;
}

/* Wrap ACK in conversational prose to test that only delimited blocks count.
 * The ACK block sits on its own lines (as a real seat-authored reply would);
 * the decoy values live in the surrounding prose. */
function ackInProse({ cmd, nonce, result, note, state, lead, trail }) {
  return (
    (lead || "Sure, here is what I found. ") + "\n" +
    ack({ cmd, nonce, result, note, state }) +
    "\n" + (trail || "\nLet me know if you need more.")
  );
}

/* A drift-correction state block Coda would return for RECENTER. */
function recenterState({ confidence, note }) {
  return {
    AUTHORITY: "Don",
    SEAT: "Coda",
    MODE: "BUILD",
    DON_INTENT: "Control surface for GCE governance ops",
    OBJECTIVE: "Re-center and strip unanchored drift",
    CURRENT_TASK: "RECENTER_SESSION",
    MATURITY: "PRODUCTION",
    STATUS: "ACTIVE",
    CONFIDENCE: String(confidence),
    BLOCKERS: "none",
    LAST_ANCHOR: "anchor-20260926-recenter",
    NEXT_ACTION: "Proceed to anchor"
  };
}

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log("[" + tag + "] " + id + " — " + name);
  if (detail) console.log("       " + String(detail).replace(/\n/g, "\n       "));
}

module.exports = {
  protocol,
  storeFactory,
  createCore,
  memBackend,
  makeFakeAdapter,
  makeCore,
  ack,
  ackInProse,
  recenterState,
  record,
  results
};
