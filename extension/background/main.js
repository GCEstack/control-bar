"use strict";

/*
 * GCE Don Control Bar — control surface core.
 *
 * This is the emitter + status surface ONLY. It contains zero GCE command
 * semantics (spec §3, §7). Responsibilities:
 *   - mint nonces and build envelopes
 *   - drive the ChatGPT adapter (send)
 *   - bind ACKs to locally issued nonces
 *   - expose lifecycle + last-state for the sidebar
 *
 * Lifecycle (spec §10):
 *   ARMED -> SENT -> ACCEPTED | REJECTED | PARTIAL | AMBIGUOUS_STATE
 * Local failures: FAILED_NOT_SENT | FAILED_SENT_UNCONFIRMED | PENDING | NO_ACTIVE_SEAT
 */

/*
 * Protocol resolution seam.
 *
 * Under Node (test harness) this file is a CommonJS module and the protocol
 * arrives via require(). In the browser background page this file is a CLASSIC
 * SCRIPT loaded AFTER lib/protocol.js, whose `const GCEProtocol` is a global
 * LEXICAL binding - reachable by bare name, but NOT as globalThis.GCEProtocol.
 *
 * The local name must therefore differ from the global name. Re-declaring
 * `GCEProtocol` here (var or const) is a SyntaxError in the browser because
 * lib/protocol.js already declared that name in the same global scope - and a
 * link-time SyntaxError means this whole file never executes, the background
 * page answers no messages, and the sidebar silently renders its static HTML.
 */
var GCEProtocolModule =
  (typeof module !== "undefined" && module.exports)
    ? require("../lib/protocol.js")
    : GCEProtocol;

function createCore({ protocol, store, adapter, adapterFn, now, sentTimeoutMs = 30000 }) {
  const clock = now || (() => Date.now());
  const lifecycle = new Map();
  const subscribers = new Set();
  // Track successfully bound ACK content hashes so the 700ms poll does not
  // re-ingest identical page text forever (F-L-02). This is a SECOND line of
  // defence only: the durable guarantee is that store.bindAck retires the
  // nonce (F-L-01), so a lost cache degrades log volume, never state safety.
  // Bounded: an unbounded Set would be a slow leak in a page that stays open
  // for days. FIFO eviction at 512 entries; the durable layer still rejects a
  // replay, so evicting an entry here cannot re-open the hole.
  const SEEN_HASH_CAP = 512;
  const seenAckHashes = new Set();

  function hashAck(ack) {
    // Hash the key immutable fields of a bound ACK
    return ack.nonce + "|" + ack.cmd + "|" + ack.result + "|" + JSON.stringify(ack.state || {});
  }

  function rememberAckHash(hash) {
    seenAckHashes.add(hash);
    while (seenAckHashes.size > SEEN_HASH_CAP) {
      const oldest = seenAckHashes.values().next().value;
      seenAckHashes.delete(oldest);
    }
  }

  /*
   * Check for SENT commands that have exceeded the timeout without an ACK.
   * Converts them to FAILED_SENT_UNCONFIRMED (spec §10 frozen failure state).
   */
  async function checkTimeouts() {
    const outstanding = await store.getOutstanding();
    const nowMs = clock();
    let changed = false;
    for (const nonce of Object.keys(outstanding)) {
      const rec = outstanding[nonce];
      if (rec.status === "SENT" && rec.sentAt) {
        if (nowMs - rec.sentAt > sentTimeoutMs) {
          await store.markLocalFailure(nonce, nowMs, "FAILED_SENT_UNCONFIRMED");
          lifecycle.set(nonce, "FAILED_SENT_UNCONFIRMED");
          changed = true;
        }
      }
    }
    if (changed) {
      notify();
    }
    return changed;
  }

  function toView(rec) {
    return {
      nonce: rec.nonce,
      commandId: rec.commandId,
      returnState: rec.returnState,
      status: rec.status,
      sentAt: rec.sentAt || null,
      ackedAt: rec.ackedAt || null,
      note: rec.ackNote || null,
      // CB-02: the typed transport reason and the composer verdict travel with
      // the record so the sidebar can tell Don what happened to his draft
      // without recomputing or inferring anything.
      reason: rec.failureReason || null,
      composerMutated: rec.composerMutated === true,
      draftPreserved: rec.draftPreserved !== false
    };
  }

  function notify() {
    const snapshot = getSnapshot();
    for (const fn of subscribers) {
      try { fn(snapshot); } catch (_) { /* observer faults must not break the core */ }
    }
  }

  function subscribe(fn) {
    subscribers.add(fn);
    getSnapshot().then((snap) => { try { fn(snap); } catch (_) {} });
    return () => subscribers.delete(fn);
  }

  async function getSnapshot() {
    const outstanding = await store.getOutstanding();
    const stateRecord = await store.getLastState();
    const session = await store.getSession();
    const lastNonce = stateRecord ? stateRecord.nonce : null;

    const live = Object.values(outstanding)
      .filter((r) => r.status === "ARMED" || r.status === "SENT")
      .sort((a, b) => (a.armedAt || 0) - (b.armedAt || 0));
    const latestLive = live.length > 0 ? live[live.length - 1] : null;

    // The most recent command of ANY terminal kind. A local failure must stay
    // visible after it happens — it is never allowed to decay back to IDLE.
    const recent = Object.values(outstanding)
      .sort((a, b) => ((a.ackedAt || a.failedAt || a.sentAt || a.armedAt || 0)) - ((b.ackedAt || b.failedAt || b.sentAt || b.armedAt || 0)));
    const latestAny = recent.length > 0 ? recent[recent.length - 1] : null;

    const LOCAL_FAILURES = new Set(["FAILED_NOT_SENT", "FAILED_SENT_UNCONFIRMED"]);

    let topState = "IDLE";
    let display = latestLive;
    if (session.closed) {
      topState = "NO_ACTIVE_SEAT";
    } else if (latestLive) {
      topState = "PENDING";
    } else if (latestAny && LOCAL_FAILURES.has(latestAny.status)) {
      topState = latestAny.status;
      display = latestAny;
    } else if (latestAny && protocol.VALID_RESULTS.has(latestAny.status)) {
      topState = latestAny.status;
      display = latestAny;
    }

    return {
      topState,
      session,
      controls: protocol.CONTROLS.map((c) => ({
        id: c.id,
        label: c.label,
        returnState: protocol.defaultReturnState(c.id)
      })),
      lastState: stateRecord,
      stateAgeMs: stateRecord ? clock() - stateRecord.receivedAt : null,
      latest: display ? toView(display) : null,
      outstandingCount: live.length
    };
  }

  /*
   * The seat that commands are addressed to.
   *
   * Production never passes one. It is resolved from AUTHORITATIVE STATE — the
   * last seat-authored snapshot — so the bar follows the active identity instead
   * of a hardcoded one. The explicit argument survives only so the test harness
   * can drive a scenario deterministically; no production call site uses it.
   */
  async function resolveSeat(explicit) {
    if (explicit) {
      const token = String(explicit).trim().toUpperCase();
      if (token && /^[A-Z][A-Z0-9_]*$/.test(token)) return token;
    }
    const record = await store.getLastState();
    return protocol.resolveSeatToken(record ? record.state : null);
  }

  async function issue(commandId, seat, payload) {
    const seatToken = await resolveSeat(seat);
    if (!seatToken) {
      // Honest failure. Before any seat has published state the bar has no idea
      // who it is addressing, and it says so rather than guessing.
      return { ok: false, topState: "NO_ACTIVE_SEAT", reason: "NO_SEAT" };
    }
    if (!protocol.isKnownControl(commandId)) {
      return { ok: false, topState: "IDLE", reason: "UNKNOWN_CONTROL" };
    }

    const session = await store.getSession();
    if (session.closed) {
      return { ok: false, topState: "NO_ACTIVE_SEAT", reason: "SESSION_CLOSED" };
    }

    const at = clock();
    const sequence = await store.nextSequence();
    const nonce = protocol.makeNonce(at, sequence);
    const returnState = protocol.defaultReturnState(commandId);

    let envelope;
    try {
      envelope = protocol.buildCommandEnvelope({
        commandId,
        seat: seatToken,
        nonce,
        frame: protocol.FRAME_CURRENT,
        returnState,
        payload
      });
    } catch (e) {
      return { ok: false, topState: "IDLE", reason: "ENVELOPE_BUILD_FAILED", error: String(e) };
    }

    await store.armCommand({ nonce, commandId, seat: seatToken, returnState, armedAt: at, envelope });
    lifecycle.set(nonce, "ARMED");
    notify();

    // Drive the adapter. Adapter failure is visible, never silent.
    const activeAdapter = typeof adapterFn === "function" ? await adapterFn() : adapter;
    let sendResult;
    try {
      sendResult = await activeAdapter.send({ envelope, nonce, commandId });
    } catch (e) {
      sendResult = { ok: false, error: String(e && e.message ? e.message : e) };
    }

    if (!sendResult || sendResult.ok !== true) {
      const detail = {
        reason: (sendResult && sendResult.error) || "ADAPTER_SEND_FAILED",
        composerMutated: sendResult ? sendResult.composerMutated === true : false,
        draftPreserved: sendResult ? sendResult.draftPreserved !== false : true
      };
      await store.markLocalFailure(nonce, clock(), "FAILED_NOT_SENT", detail);
      lifecycle.set(nonce, "FAILED_NOT_SENT");
      notify();
      return Object.assign({ ok: false, topState: "FAILED_NOT_SENT", nonce }, detail);
    }

    /*
     * CB-02: an adapter result of ok:true is only real if the transport also
     * proved the composer was cleared. The adapter already downgrades an
     * unverified send to ok:false; this is the second, independent gate, so a
     * future adapter that forgets to downgrade still cannot report a send as
     * successful. Success is earned twice or not at all.
     */
    if (sendResult.clearedComposer !== true) {
      const detail = {
        reason: "SEND_NOT_CONFIRMED",
        composerMutated: sendResult.composerMutated === true,
        draftPreserved: sendResult.draftPreserved !== false
      };
      await store.markLocalFailure(nonce, clock(), "FAILED_NOT_SENT", detail);
      lifecycle.set(nonce, "FAILED_NOT_SENT");
      notify();
      return Object.assign({ ok: false, topState: "FAILED_NOT_SENT", nonce }, detail);
    }

    await store.markSent(nonce, clock());
    lifecycle.set(nonce, "SENT");
    notify();

    return { ok: true, topState: "PENDING", nonce, commandId, returnState, envelope };
  }

  /*
   * Ingest raw page text, extract ACKs, bind to outstanding nonces.
   * Unmatched ACKs are recorded as rejected and NEVER mutate state (spec §8).
   * Identical ACK blocks already successfully bound are deduplicated:
   * they do not re-bind, do not refresh receivedAt, do not flood logs.
   */
  async function ingestPageText(text) {
    const at = clock();
    const { acks, rejected, truncated } = protocol.parseAllAcks(text);

    if (truncated) {
      await store.appendRejectedAck({ reason: "ACK_TRUNCATED", at, block: truncated });
    }

    for (const r of rejected) {
      await store.appendRejectedAck({ reason: r.reason, at, block: r.block });
    }

    const bound = [];
    for (const ack of acks) {
      const ackHash = hashAck(ack);
      if (seenAckHashes.has(ackHash)) {
        // Duplicate ACK already processed - inert, no log, no state refresh
        continue;
      }
      const verdict = await store.bindAck(ack, at);
      const rec = verdict.bound;
      if (!rec) {
        // Discarded as protocol input. The reason is the transport's, not a
        // guess: a never-issued nonce and a wrong-command ACK are different
        // events and must stay distinguishable in the discarded-input log.
        await store.appendRejectedAck({
          reason: verdict.reason,
          at,
          nonce: ack.nonce,
          cmd: ack.cmd,
          expected_cmd: verdict.expected || null,
          block: ack.cmd + "/" + ack.result
        });
        continue;
      }
      rememberAckHash(ackHash);
      // Cache seat-authored state whenever it arrives in a nonce-bound ACK.
      // RETURN_STATE only governs whether we REQUEST state. We never refuse
      // valid state the seat chose to send.
      if (ack.state && Object.keys(ack.state).length > 0) {
        await store.cacheState(ack.state, { receivedAt: at, nonce: ack.nonce, commandId: rec.commandId });
      }
      lifecycle.set(ack.nonce, ack.result);
      bound.push({ ack, record: toView(rec) });

      if (rec.commandId === "END_SESSION" && ack.result === "ACCEPTED") {
        await store.closeSession(ack.nonce, at);
      }
    }

    notify();
    return { bound, rejectedCount: rejected.length };
  }

  async function isOutstanding(nonce) {
    return store.isOutstanding(nonce);
  }

  return {
    issue,
    ingestPageText,
    getSnapshot,
    subscribe,
    isOutstanding,
    toView,
    checkTimeouts
  };
}

/* ------------------------------------------------------------------ *
 * BROWSER WIRING
 * Runs only in the WebExtension background page. The factory above is
 * environment-agnostic so the identical code is what the test harness runs.
 *
 * `GCEStore` and `GCEChatGPTAdapter` are bare-name references to global
 * LEXICAL bindings created by lib/store.js and background/chatgpt-adapter.js,
 * which the manifest loads BEFORE this file. They are deliberately NOT
 * re-declared here (re-declaring is a link-time SyntaxError that silently
 * kills this entire file) and deliberately NOT read off globalThis (a `const`
 * binding is not a property of the global object). By the time this script
 * runs both are initialized, so the typeof guards are safe.
 * ------------------------------------------------------------------ */
if (typeof browser !== "undefined" && browser.runtime && browser.runtime.id &&
    typeof GCEStore !== "undefined" && typeof GCEChatGPTAdapter !== "undefined" &&
    typeof GCEKimiAdapter !== "undefined" &&
    typeof GCEProtocolModule !== "undefined" && GCEProtocolModule) {

  const protocol = GCEProtocolModule;
  const store = GCEStore.createStore({
    get: (key) => browser.storage.local.get(key),
    set: (bag) => browser.storage.local.set(bag)
  });

  const ADAPTERS = {
    chatgpt: GCEChatGPTAdapter,
    kimi: GCEKimiAdapter
  };

  function detectAdapter() {
    const chatgptPattern = /^https:\/\/(www\.|chat\.)?chatgpt\.com\//;
    const kimiPattern = /^https:\/\/(www\.|kimi\.)?kimi\.com\//;

    // Check all tabs in current window, not just active one (sidebar becomes active when clicked)
    return browser.tabs.query({ currentWindow: true }).then((tabs) => {
      for (const tab of tabs) {
        if (chatgptPattern.test(tab.url)) return ADAPTERS.chatgpt;
        if (kimiPattern.test(tab.url)) return ADAPTERS.kimi;
      }
      return ADAPTERS.chatgpt;
    }).catch(() => ADAPTERS.chatgpt);
  }

  const core = createCore({ protocol, store, adapter: GCEChatGPTAdapter, adapterFn: detectAdapter });
  let currentAdapter = GCEChatGPTAdapter;

  // ---- keyboard shortcuts via the commands API (spec §4) ----
  browser.commands.onCommand.addListener((name) => {
    const control = protocol.controlByCommandName(name);
    if (!control) return;
    detectAdapter().then((adapter) => {
      currentAdapter = adapter;
      // No seat argument: the core resolves the active identity from state.
      core.issue(control.id);
    });
  });

  // ---- sidebar wiring ----
  function pushToSidebar() {
    core.getSnapshot().then((snap) => {
      try { browser.runtime.sendMessage({ type: "GCE_SNAPSHOT", snapshot: snap }); } catch (_) {}
    });
  }
  core.subscribe(pushToSidebar);

  // ---- adapter -> core: observe assistant output, bind ACKs ----
  async function pollOnce() {
    await core.checkTimeouts();
    const adapter = await detectAdapter();
    currentAdapter = adapter;
    let r;
    try {
      r = await adapter.observeAssistantOutput();
    } catch (_) {
      /* DON CORRECTION (1.7.4): a poll that throws must not kill the interval.
       * An unhandled rejection here stopped ingestion permanently, which is
       * why the strip stayed "—" for the rest of the session. */
      return;
    }
    if (r && r.ok && r.text) {
      await core.ingestPageText(r.text);
    }
    if (r && r.ok && r.observed) {
      try { browser.runtime.sendMessage({ type: "GCE_OBSERVED_STATE", observed: r.observed }); } catch (_) {}
    }
  }
  setInterval(pollOnce, 700);

  /* DON CORRECTION (1.7.4): ingest immediately on load instead of waiting a
   * full poll interval, and again once a page finishes loading. Opening the
   * chat should already show what is being worked on. */
  pollOnce();
  if (typeof browser !== "undefined" && browser.tabs && browser.tabs.onUpdated) {
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo && changeInfo.status === "complete") pollOnce();
    });
  }

  // ---- expose adapter detection for debugging ----
  globalThis.__gceDetectAdapter = detectAdapter;

  // ---- messages from the sidebar and the content script ----
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg) return undefined;
    if (msg.type === "GCE_ISSUE") {
      /*
       * F-L-06: GCE_ISSUE is accepted ONLY from this extension's own context.
       * The test is `sender.id === runtime.id`, not a truthiness check on
       * sender: an ABSENT sender is a message that did not come from our
       * extension context, and letting it through would make the gate a
       * no-op for exactly the case it exists to refuse.
       */
      if (!sender || !sender.id || sender.id !== browser.runtime.id) {
        return Promise.resolve({ ok: false, topState: "IDLE", reason: "INVALID_SENDER" });
      }
      return detectAdapter().then((adapter) => {
        currentAdapter = adapter;
        // No seat argument: the panel cannot choose the identity either. The core
        // resolves it from authoritative state, so a tampered panel cannot redirect
        // a command at a seat the active session does not belong to.
        return core.issue(msg.commandId, undefined, msg.payload).then((result) => {
          return { ...result, commandId: msg.commandId };
        });
      });
    }
    if (msg.type === "GCE_GET_SNAPSHOT") {
      return core.getSnapshot();
    }
    if (msg.type === "GCE_LOAD_BOOTSTRAP") {
      return detectAdapter().then((adapter) => {
        currentAdapter = adapter;
        if (!adapter || typeof adapter.stage !== "function") {
          return { ok: false, error: "ADAPTER_MISSING_STAGE: " + (adapter ? "no stage method" : "no adapter") };
        }
        return adapter.stage(msg.text);
      });
    }
    if (msg.type === "GCE_GET_LOG") {
      return store.getCommandLog().then((commandLog) =>
        store.getAckLog().then((ackLog) =>
          store.getRejectedAcks().then((rejectedAcks) => ({ commandLog, ackLog, rejectedAcks }))));
    }
    if (msg.type === "GCE_OPEN_SESSION") {
      return store.openSession().then(() => core.getSnapshot());
    }
    if (msg.type === "GCE_CONTENT_READY") {
      pollOnce();
      return Promise.resolve({ ok: true });
    }
    if (msg.type === "GCE_WRITE_FINDINGS") {
      // GCE FINDINGS OUTPUT — AUTO-FIRE for browser surfaces.
      // A findings artifact must be filed under the ACTIVE identity, not under a
      // hardcoded one or a literal "UNKNOWN" — same contract as command addressing.
      return resolveSeat(msg.seat).then((resolvedSeat) => {
        const seat = resolvedSeat || "UNIDENTIFIED";
      const source = msg.source || "auto";
      const findings = msg.findings || "";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `FINDINGS_${seat}_${timestamp}.txt`;
      const content = `SEAT: ${seat}\nTIMESTAMP: ${new Date().toISOString()}\nSOURCE: ${source}\nFINDINGS:\n${findings}`;

      // Write to Downloads folder via downloads API
      return browser.downloads.download({
        url: "data:text/plain;charset=utf-8," + encodeURIComponent(content),
        filename: filename,
        saveAs: false
      }).then((downloadId) => {
        // Notify the user
        browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
          if (tabs[0]) {
            browser.tabs.sendMessage(tabs[0].id, {
              type: "GCE_FINDINGS_WRITTEN",
              filename: filename,
              downloadId: downloadId
            }).catch(() => {});
          }
        });
        return { ok: true, filename: filename, downloadId: downloadId };
      }).catch((err) => {
          return { ok: false, error: String(err) };
        });
      });
    }
    return undefined;
  });

  // Expose for the sidebar's direct reads / debugging.
  browser.runtime.getBrowserInfo
    ? browser.runtime.getBrowserInfo().then((info) => { globalThis.__gceBrowserInfo = info; })
    : undefined;
  globalThis.__gceCore = core;
  globalThis.__gceStore = store;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createCore };
}
