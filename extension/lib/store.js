"use strict";

/*
 * GCE Don Control Bar — storage layer.
 *
 * storage.local is OBSERVABILITY / CACHE ONLY (spec §11).
 * It is never canonical GCE session state. Everything here is either an
 * outbound command record, an inbound ACK record, or a cache of what the
 * seat last authored.
 *
 * Backing store is injected so the test harness can run this file under
 * plain Node with an in-memory shim. In the browser it is browser.storage.local.
 */

const GCEStore = (() => {
  const KEYS = {
    outstanding: "gce.outstanding",       // nonce -> in-flight command record
    commandLog: "gce.commandLog",         // append-only, outbound
    ackLog: "gce.ackLog",                 // append-only, inbound accepted ACKs
    rejectedAcks: "gce.rejectedAcks",     // discarded protocol input
    lastState: "gce.lastState",           // last seat-authored state cache
    session: "gce.session",               // session_closed flag + close nonce
    sequence: "gce.sequence"              // nonce sequence counter
  };

  const MAX_LOG = 500;

  function createStore(backend) {
    if (!backend || typeof backend.get !== "function" || typeof backend.set !== "function") {
      throw new Error("GCEStore requires a storage backend with get/set");
    }

    async function read(key, fallback) {
      const bag = await backend.get(key);
      const value = bag ? bag[key] : undefined;
      return value === undefined ? fallback : value;
    }

    async function write(key, value) {
      const bag = {};
      bag[key] = value;
      await backend.set(bag);
    }

    let sequenceLock = Promise.resolve();

    async function nextSequence() {
      return sequenceLock = sequenceLock.then(async () => {
        const current = Number(await read(KEYS.sequence, 0)) || 0;
        const next = current + 1;
        await write(KEYS.sequence, next);
        return next;
      });
    }

    /*
     * ARMED -> SENT. Register the outstanding nonce BEFORE the adapter runs so
     * an ACK that arrives during the send window can still be bound.
     */
    async function armCommand(record) {
      const outstanding = await read(KEYS.outstanding, {});
      outstanding[record.nonce] = {
        nonce: record.nonce,
        commandId: record.commandId,
        seat: record.seat,
        returnState: record.returnState === true,
        armedAt: record.armedAt,
        sentAt: null,
        status: "ARMED",
        envelope: record.envelope
      };
      await write(KEYS.outstanding, outstanding);
      await appendCommandLog({
        nonce: record.nonce,
        commandId: record.commandId,
        returnState: record.returnState === true,
        status: "ARMED",
        at: record.armedAt
      });
      return outstanding[record.nonce];
    }

    async function markSent(nonce, at) {
      const outstanding = await read(KEYS.outstanding, {});
      const rec = outstanding[nonce];
      if (!rec) return null;
      rec.sentAt = at;
      rec.status = "SENT";
      await write(KEYS.outstanding, outstanding);
      await appendCommandLog({ nonce, commandId: rec.commandId, status: "SENT", at });
      return rec;
    }

    /*
     * A local failure. `detail` is the typed verdict the transport reported:
     *   { reason, composerMutated, draftPreserved }
     * It is recorded verbatim, never invented, and never collapsed into the
     * status token — a status alone cannot tell Don whether his draft
     * survived. Callers may pass a bare string for the reason.
     */
    async function markLocalFailure(nonce, at, failureKind, detail) {
      const outstanding = await read(KEYS.outstanding, {});
      const rec = outstanding[nonce];
      if (!rec) return null;
      const d = (detail && typeof detail === "object") ? detail : { reason: detail };
      rec.status = failureKind;
      rec.failedAt = at;
      if (d.reason !== undefined && d.reason !== null) rec.failureReason = String(d.reason);
      if (d.composerMutated !== undefined) rec.composerMutated = d.composerMutated === true;
      if (d.draftPreserved !== undefined) rec.draftPreserved = d.draftPreserved !== false;
      await write(KEYS.outstanding, outstanding);
      await appendCommandLog({
        nonce, commandId: rec.commandId, status: failureKind, at,
        reason: rec.failureReason || null,
        composerMutated: rec.composerMutated === true,
        draftPreserved: rec.draftPreserved !== false
      });
      return rec;
    }

    /*
     * Nonce binding (spec §8). Returns { bound, reason }.
     *
     *   bound  = the bound record, or null.
     *   reason = null on success; otherwise the exact rejection reason.
     *
     * The reason is DISTINGUISHED, not collapsed. A never-issued nonce and a
     * nonce whose ACK names a different command are two different events and
     * must not both be logged as UNMATCHED_NONCE: a log that cannot tell them
     * apart cannot be used to reason about provenance after the fact.
     *
     * On a successful bind the nonce is RETIRED from outstanding (consumed),
     * so a replay can never mutate state a second time. The append-only logs
     * keep the history. (F-L-01, F-L-04.)
     */
    async function bindAck(ack, at) {
      const outstanding = await read(KEYS.outstanding, {});
      const rec = outstanding[ack.nonce];
      if (!rec) return { bound: null, reason: "UNMATCHED_NONCE" };
      if (rec.commandId !== ack.cmd) {
        return { bound: null, reason: "CMD_MISMATCH", expected: rec.commandId, got: ack.cmd };
      }
      rec.ackedAt = at;
      rec.status = ack.result;
      rec.ackNote = ack.note;
      if (ack.state && Object.keys(ack.state).length > 0) {
        rec.ackState = ack.state;
      }
      delete outstanding[ack.nonce];
      await write(KEYS.outstanding, outstanding);
      await appendAckLog({ ...ack, receivedAt: at, commandId: rec.commandId });
      return { bound: rec, reason: null };
    }

    async function isOutstanding(nonce) {
      const outstanding = await read(KEYS.outstanding, {});
      return Object.prototype.hasOwnProperty.call(outstanding, nonce);
    }

    async function getOutstanding() {
      return read(KEYS.outstanding, {});
    }

    async function getRecord(nonce) {
      const outstanding = await read(KEYS.outstanding, {});
      return outstanding[nonce] || null;
    }

    async function pruneOutstanding(maxAgeMs, now) {
      const outstanding = await read(KEYS.outstanding, {});
      let changed = false;
      for (const nonce of Object.keys(outstanding)) {
        const rec = outstanding[nonce];
        const stamp = rec.ackedAt || rec.failedAt || rec.sentAt || rec.armedAt || 0;
        if (now - stamp > maxAgeMs) {
          delete outstanding[nonce];
          changed = true;
        }
      }
      if (changed) await write(KEYS.outstanding, outstanding);
      return changed;
    }

    async function appendCommandLog(entry) {
      const log = await read(KEYS.commandLog, []);
      log.push(entry);
      while (log.length > MAX_LOG) log.shift();
      await write(KEYS.commandLog, log);
      return entry;
    }

    async function appendAckLog(entry) {
      const log = await read(KEYS.ackLog, []);
      log.push(entry);
      while (log.length > MAX_LOG) log.shift();
      await write(KEYS.ackLog, log);
      return entry;
    }

    async function appendRejectedAck(entry) {
      const log = await read(KEYS.rejectedAcks, []);
      log.push(entry);
      while (log.length > MAX_LOG) log.shift();
      await write(KEYS.rejectedAcks, log);
      return entry;
    }

    async function getCommandLog() { return read(KEYS.commandLog, []); }
    async function getAckLog() { return read(KEYS.ackLog, []); }
    async function getRejectedAcks() { return read(KEYS.rejectedAcks, []); }

    /*
     * Last seat-authored state cache. ONLY written from a nonce-bound ACK.
     * No inference, no calculation, no default fill-in.
     */
    async function cacheState(state, meta) {
      if (!state || Object.keys(state).length === 0) return null;
      const record = {
        state: Object.assign(Object.create(null), state),
        receivedAt: meta.receivedAt,
        nonce: meta.nonce,
        commandId: meta.commandId
      };
      await write(KEYS.lastState, record);
      return record;
    }

    async function getLastState() { return read(KEYS.lastState, null); }

    async function getSession() { return read(KEYS.session, { closed: false, closedByNonce: null, closedAt: null }); }

    async function closeSession(nonce, at) {
      await write(KEYS.session, { closed: true, closedByNonce: nonce, closedAt: at });
    }

    async function openSession() {
      await write(KEYS.session, { closed: false, closedByNonce: null, closedAt: null });
    }

    return {
      KEYS,
      read,
      write,
      nextSequence,
      armCommand,
      markSent,
      markLocalFailure,
      bindAck,
      isOutstanding,
      getOutstanding,
      getRecord,
      pruneOutstanding,
      appendCommandLog,
      appendAckLog,
      appendRejectedAck,
      getCommandLog,
      getAckLog,
      getRejectedAcks,
      cacheState,
      getLastState,
      getSession,
      closeSession,
      openSession
    };
  }

  return { createStore, KEYS, MAX_LOG };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = GCEStore;
}
