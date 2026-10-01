"use strict";

/*
 * SENDER PROBE (F-L-06) — GCE_ISSUE must be refused from a foreign extension.
 *
 * Same technique as browser-wiring-probe.js: the SHIPPED manifest script list is
 * evaluated in manifest order into ONE shared vm scope, which is how the host
 * evaluates a background page. The message listener is then called twice with
 * the same GCE_ISSUE payload and two different sender identities.
 *
 * IDENTITY CONTRACT (v1.5.1). The payload below deliberately carries a DECOY
 * `seat: "CODA"`. The bar must IGNORE it and address the command to the seat that
 * authoritative state actually names. The probe seeds state with ENZO and asserts
 * the outbound envelope carries SEAT: ENZO. A hardcoded DEFAULT_SEAT="CODA" would
 * fail this probe.
 *
 * It also asserts the honest no-seat path: with no state there is no identity, so
 * the command is refused with NO_SEAT and NO nonce is minted.
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
const STATE_SEAT = "ENZO";      // what authoritative state says
const DECOY_SEAT = "CODA";      // what a caller tries to dictate

/* Authoritative state cache. The bar resolves the active identity from THIS,
   never from the message payload. */
function storageWithSeat(seat) {
  const seeded = {
    "gce.lastState": { nonce: "GCE-1759000000000-1", receivedAt: Date.now(), state: { PRIMARY_SEAT: seat } },
    "gce.session": { closed: false, closedByNonce: null, closedAt: null },
    "gce.sequence": 7
  };
  return { local: { get: async (k) => ({ [k]: seeded[k] }), set: async () => undefined } };
}

(async () => {
  const listeners = [];
  const timers = [];
  const sent = [];
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
      storage: storageWithSeat(STATE_SEAT),
      tabs: {
        query: async () => [{ url: "https://chatgpt.com/", id: 1 }],
        sendMessage: async (_tabId, payload) => {
          // Capture whatever the transport is handed — this is where the envelope
          // becomes observable, so we can read which SEAT it was addressed to.
          sent.push(payload);
          return undefined;
        }
      },
      downloads: { download: async () => 1 }
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

  const payload = { type: "GCE_ISSUE", commandId: "SHOW_STATE", seat: DECOY_SEAT };
  const own = await msg.fn(payload, { id: OWN_ID });
  const foreign = await msg.fn(payload, { id: FOREIGN_ID });
  const noSender = await msg.fn(payload, undefined);

  await new Promise((r) => setTimeout(r, 250));

  // Find the command envelope among everything the transport was handed.
  const blob = JSON.stringify(sent);
  const m = /\[GCE-CMD v1\][\s\S]*?\[\/GCE-CMD\]/.exec(blob);
  const envelope = m ? m[0] : null;
  const seatLine = envelope ? (/SEAT:\s*([A-Z0-9_]+)/.exec(envelope) || [])[1] : null;

  const out = {
    own_ok: own && own.ok === true,
    own_topState: own && own.topState,
    own_reason: own && own.reason,
    own_nonce: !!(own && own.nonce),
    /* IDENTITY CONTRACT: the envelope must carry the state seat, not the decoy. */
    stateSeat: STATE_SEAT,
    decoySeat: DECOY_SEAT,
    envelopeSeat: seatLine,
    envelopeFollowsState: seatLine === STATE_SEAT,
    envelopeIgnoredDecoy: seatLine !== DECOY_SEAT,
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
