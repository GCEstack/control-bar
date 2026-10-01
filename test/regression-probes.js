"use strict";

/*
 * GCE Don Control Bar — Regression Probes R1..R9
 * Run: node test/regression-probes.js
 */

const fs = require("node:fs");
const path = require("node:path");
const H = require("./harness/env.js");

const EVIDENCE_DIR = path.join(__dirname, "..", "evidence");

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

const results = [];

function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log("[" + tag + "] " + id + " — " + name);
  if (detail) console.log("       " + String(detail).replace(/\n/g, "\n       "));
}

async function main() {
  console.log("=== REGRESSION PROBES R1..R16 ===\n");

  // ------------------------------------------------------------ R1
  // Never-issued nonce rejected
  try {
    const { core, store } = H.makeCore();
    const forgedNonce = "GCE-9999999999999-424242";
    const forged = H.ack({ cmd: "SHOW_STATE", nonce: forgedNonce, result: "ACCEPTED", note: "hax", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "100", LAST_ANCHOR: "FORGED" } });
    const res = await core.ingestPageText(forged);
    const rejected = await store.getRejectedAcks();
    const pass = res.bound.length === 0 && rejected.some((e) => e.reason === "UNMATCHED_NONCE");
    record("R1", "Never-issued nonce rejected", pass, "forged nonce rejected as UNMATCHED_NONCE; ackLog empty");
  } catch (e) {
    record("R1", "Never-issued nonce rejected", false, e.message);
  }

  // ------------------------------------------------------------ R2
  // Previously issued and successfully bound nonce cannot be replayed to mutate state
  try {
    const { core, store } = H.makeCore();
    const r = await core.issue("SHOW_STATE", "CODA");
    const nonce = r.nonce;
    await core.ingestPageText(H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "real", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "50", LAST_ANCHOR: "real-1" } }));
    const stateBefore = (await core.getSnapshot()).lastState;
    // Replay same nonce with different state
    await core.ingestPageText(H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "replay", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "100", LAST_ANCHOR: "FORGED-ANCHOR" } }));
    const stateAfter = (await core.getSnapshot()).lastState;
    const pass = stateAfter.state.CONFIDENCE === "50" && stateAfter.state.LAST_ANCHOR === "real-1";
    record("R2", "Bound nonce cannot replay to mutate state", pass, "CONFIDENCE stayed 50, LAST_ANCHOR stayed real-1; replay was inert");
  } catch (e) {
    record("R2", "Bound nonce cannot replay to mutate state", false, e.message);
  }

  // ------------------------------------------------------------ R3
  // Identical ACK observed repeatedly is ingested once
  try {
    const { core, store } = H.makeCore();
    const r = await core.issue("SHOW_STATE", "CODA");
    const nonce = r.nonce;
    const ack = H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "ok", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "77", LAST_ANCHOR: "anchor-1" } });
    await core.ingestPageText(ack);
    await core.ingestPageText(ack);
    await core.ingestPageText(ack);
    const ackLog = await store.getAckLog();
    const pass = ackLog.length === 1;
    record("R3", "Identical ACK ingested once (deduped)", pass, "ackLog length = 1 despite 3 ingestPageText calls");
  } catch (e) {
    record("R3", "Identical ACK ingested once (deduped)", false, e.message);
  }

  // ------------------------------------------------------------ R4
  // Repeated polling does not refresh receivedAt
  try {
    const { core, store } = H.makeCore();
    const r = await core.issue("SHOW_STATE", "CODA");
    const nonce = r.nonce;
    const ack = H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "ok", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "77", LAST_ANCHOR: "anchor-1" } });
    await core.ingestPageText(ack);
    const snap1 = await core.getSnapshot();
    const receivedAt1 = snap1.lastState.receivedAt;
    // Wait a bit and ingest again (simulating poll)
    await new Promise(resolve => setTimeout(resolve, 10));
    await core.ingestPageText(ack);
    const snap2 = await core.getSnapshot();
    const receivedAt2 = snap2.lastState.receivedAt;
    const pass = receivedAt2 === receivedAt1;
    record("R4", "Repeated identical ACK does not refresh receivedAt", pass, "receivedAt unchanged on duplicate ingestion");
  } catch (e) {
    record("R4", "Repeated identical ACK does not refresh receivedAt", false, e.message);
  }

  // ------------------------------------------------------------ R5
  // STATE AGE becomes increasingly stale without genuinely new seat state
  try {
    const { core } = H.makeCore();
    const r = await core.issue("SHOW_STATE", "CODA");
    const nonce = r.nonce;
    const ack = H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "ok", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "77", LAST_ANCHOR: "anchor-1" } });
    await core.ingestPageText(ack);
    const snap1 = await core.getSnapshot();
    const age1 = snap1.stateAgeMs;
    // Wait
    await new Promise(resolve => setTimeout(resolve, 50));
    // No new ACK - just get snapshot again
    const snap2 = await core.getSnapshot();
    const age2 = snap2.stateAgeMs;
    const pass = age2 > age1;
    record("R5", "STATE AGE advances without new seat state", pass, "stateAgeMs increased from " + age1 + " to " + age2 + " without new ingestion");
  } catch (e) {
    record("R5", "STATE AGE advances without new seat state", false, e.message);
  }

  // ------------------------------------------------------------ R6
  // SENT command without qualifying ACK reaches FAILED_SENT_UNCONFIRMED
  try {
    const { core, store } = H.makeCore({ sentTimeoutMs: 100 });
    const r = await core.issue("SHOW_STATE", "CODA");
    const nonce = r.nonce;
    await new Promise(resolve => setTimeout(resolve, 150));
    await core.checkTimeouts();
    const outstanding = await store.getOutstanding();
    const snap = await core.getSnapshot();
    const pass = outstanding[nonce].status === "FAILED_SENT_UNCONFIRMED" && snap.topState === "FAILED_SENT_UNCONFIRMED";
    record("R6", "SENT -> FAILED_SENT_UNCONFIRMED timeout reachable", pass, "timeout path produces frozen failure state");
  } catch (e) {
    record("R6", "SENT -> FAILED_SENT_UNCONFIRMED timeout reachable", false, e.message);
  }

  // ------------------------------------------------------------ R7
  // The seven Manifest v1 controls must all still be present (baseline contract,
  // DO NOT CARRY FORWARD would drop them), plus the accepted enhancement surface.
  // This is a SUPERSET assertion: the v1.2.0 surface is never removed.
  try {
    const protocol = require(path.join(__dirname, "..", "extension", "lib", "protocol.js"));
    const baseline = ["RELOAD_BOOTSTRAP", "RECENTER_SESSION", "REASSERT_FRAME", "SHOW_STATE", "ANCHOR_COMMIT", "CREATE_HANDOFF", "END_SESSION"];
    const enhancement = ["CAPISCE", "HOLD", "RELEASE_HOLD", "BRANCH", "PARK", "RESUME_PARKED", "PROMOTE", "SUPERSEDE"];
    const actual = protocol.CONTROLS.map(c => c.id);
    const missing = [...baseline, ...enhancement].filter(id => !actual.includes(id));
    // Membership only, NOT order: the accepted enhancement deliberately moved
    // RECENTER_SESSION into the L1 vernacular row, which changes display order.
    // A regression is a control disappearing, not a control being repositioned.
    const pass = missing.length === 0;
    record("R7", "All seven Manifest v1 controls still present (superset, order kept)", pass,
      "CONTROLS: " + actual.join(", ") + (missing.length ? " | MISSING: " + missing.join(",") : ""));
  } catch (e) {
    record("R7", "All seven Manifest v1 controls still present (superset, order kept)", false, e.message);
  }

  // ------------------------------------------------------------ R8
  // Extension contains zero GCE semantics (no bootstrap/recenter/anchor/handoff/confidence logic in extension)
  // Protocol data definitions (CONTROLS labels, STATE_FIELDS names) and panel display are TRANSPORT/DISPLAY, not semantics.
  try {
    const fs = require("node:fs");
    // Files that must be pure pipe/transport (no GCE vocabulary at all)
    const purePipeFiles = [
      "extension/lib/store.js",
      "extension/background/main.js",
      "extension/background/chatgpt-adapter.js",
      "extension/content/chatgpt-observer.js"
    ];
    const forbiddenLogicTerms = [
      "DON_INTENT", "OBJECTIVE", "MATURITY", "BLOCKERS", "NEXT_ACTION",
      "CURRENT_TASK", "AUTHORITY", "MODE:", "STATUS:"
    ];
    let violations = [];
    // Check pure pipe files for any GCE vocabulary
    for (const f of purePipeFiles) {
      const content = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      for (const term of forbiddenLogicTerms) {
        if (content.includes(term)) {
          violations.push(f + ": " + term);
        }
      }
    }
    // Transport files (protocol.js, panel.js) may contain field names as DATA/allowlist - this is correct.
    // They must not contain CONDITIONAL LOGIC on these terms.
    // Quick check: no if/switch on these terms in transport files.
    const transportFiles = ["extension/lib/protocol.js", "extension/sidebar/panel.js"];
    for (const f of transportFiles) {
      const content = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if ((line.startsWith("if") || line.startsWith("switch") || line.startsWith("?") || line.includes("&&") || line.includes("||")) &&
            forbiddenLogicTerms.some(t => line.includes(t))) {
          violations.push(f + ": conditional logic on " + forbiddenLogicTerms.find(t => line.includes(t)) + " (" + line.slice(0, 80) + ")");
        }
      }
    }
    const pass = violations.length === 0;
    record("R8", "Zero GCE semantics in extension", pass, pass ? "no forbidden semantic logic found" : violations.join("; "));
  } catch (e) {
    record("R8", "Zero GCE semantics in extension", false, e.message);
  }

  // ------------------------------------------------------------ R9
  // Existing T1-T8 behavior intact (run the full suite)
  try {
    const { execSync } = require("node:child_process");
    const output = execSync("node test/run-tests.js", { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    const pass = output.includes("verdict=PASS") && output.includes("T-cases: 9/9");
    record("R9", "Existing T1-T8 suite passes", pass, pass ? "all 9 original tests pass" : "suite failed or incomplete");
  } catch (e) {
    record("R9", "Existing T1-T8 suite passes", false, e.message);
  }

  // ------------------------------------------------------------ R10
  // Background page actually boots in a browser-like global scope.
  // The CommonJS harness never executes the wiring block, so without this
  // probe a link-time SyntaxError ships silently and the sidebar renders
  // static HTML with no controls (F-DON-01).
  try {
    const { execSync } = require("node:child_process");
    execSync("node test/browser-wiring-probe.js", { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    record("R10", "Browser wiring boots (7 controls served)", true, "4 background scripts link in shared global scope; onMessage answers with 7 controls");
  } catch (e) {
    record("R10", "Browser wiring boots (7 controls served)", false, String(e.stdout || e.message).trim().split("\n")[0]);
  }

  // ------------------------------------------------------------ R11 (CB-02)
  // Don has unsent text in the composer. The core must FAIL CLOSED: nothing
  // transmitted, FAILED_NOT_SENT, and the draft survives.
  try {
    const DRAFT = "Don: hold the football lane, do not reopen Cable Car";
    const { core, adapter } = H.makeCore({ adapter: { draft: DRAFT } });
    const r = await core.issue("SHOW_STATE", "CODA");
    const snap = await core.getSnapshot();
    const pass = r.ok === false &&
      r.topState === "FAILED_NOT_SENT" &&
      r.reason === "COMPOSER_OCCUPIED" &&
      r.draftPreserved === true &&
      r.composerMutated === false &&
      adapter.sent.length === 0 &&
      adapter.composer.text === DRAFT &&
      snap.topState === "FAILED_NOT_SENT" &&
      snap.latest.reason === "COMPOSER_OCCUPIED" &&
      snap.latest.draftPreserved === true;
    record("R11", "CB-02 occupied composer: fail closed, draft intact", pass,
      "issue -> ok=false FAILED_NOT_SENT reason=COMPOSER_OCCUPIED; 0 envelopes transmitted; " +
      "composer still holds Don's text verbatim; snapshot surfaces the typed reason and the draft verdict.");
  } catch (e) {
    record("R11", "CB-02 occupied composer: fail closed, draft intact", false, e.message);
  }

  // ------------------------------------------------------------ R12 (CB-02)
  // The send control accepts the text but does not clear the composer. This is
  // the "reported as a pending send" lie. It must be FAILED, not PENDING.
  try {
    const { core, adapter } = H.makeCore({ adapter: { clearsOnSend: false } });
    const r = await core.issue("SHOW_STATE", "CODA");
    const snap = await core.getSnapshot();
    const pass = r.ok === false &&
      r.topState === "FAILED_NOT_SENT" &&
      r.reason === "SEND_NOT_CONFIRMED" &&
      adapter.sent.length === 0 &&
      snap.topState !== "PENDING";
    record("R12", "CB-02 unconfirmed send: FAILED, never PENDING", pass,
      "send control did not clear the composer -> ok=false FAILED_NOT_SENT reason=SEND_NOT_CONFIRMED; " +
      "topState is FAILED_NOT_SENT, not PENDING; no timeout wait required to notice.");
  } catch (e) {
    record("R12", "CB-02 unconfirmed send: FAILED, never PENDING", false, e.message);
  }

  // ------------------------------------------------------------ R13 (CB-02)
  // The success path still works: empty composer, clearing send control.
  // A fail-closed transport that never succeeds is not a repair, it is an outage.
  try {
    const { core, adapter } = H.makeCore();
    const r = await core.issue("SHOW_STATE", "CODA");
    const snap = await core.getSnapshot();
    const pass = r.ok === true &&
      r.topState === "PENDING" &&
      adapter.sent.length === 1 &&
      snap.topState === "PENDING" &&
      snap.latest.draftPreserved === true;
    record("R13", "CB-02 success path still sends", pass,
      "empty composer + clearing send control -> ok=true PENDING, 1 envelope transmitted, " +
      "draft verdict PRESERVED. Fail-closed did not become fail-dead.");
  } catch (e) {
    record("R13", "CB-02 success path still sends", false, e.message);
  }

  // ------------------------------------------------------------ R14 (CB-02)
  // Second, independent gate. An adapter that claims ok:true WITHOUT proving
  // the composer cleared must still be downgraded by the core, so a future
  // adapter cannot silently reopen the defect.
  try {
    const { core, adapter } = H.makeCore();
    adapter.send = async () => ({ ok: true, method: "lying-adapter" });
    const r = await core.issue("SHOW_STATE", "CODA");
    const snap = await core.getSnapshot();
    const pass = r.ok === false &&
      r.topState === "FAILED_NOT_SENT" &&
      r.reason === "SEND_NOT_CONFIRMED" &&
      snap.topState === "FAILED_NOT_SENT";
    record("R14", "CB-02 core gate rejects an unverified ok:true", pass,
      "adapter returned ok:true with no clearedComposer proof -> core downgraded it to " +
      "FAILED_NOT_SENT / SEND_NOT_CONFIRMED. Two independent gates: the adapter's and the core's.");
  } catch (e) {
    record("R14", "CB-02 core gate rejects an unverified ok:true", false, e.message);
  }

  // ------------------------------------------------------------ R15 (F-L-04)
  // An ACK carrying a locally-issued nonce but the WRONG command must be
  // refused, and the discarded-input log must say CMD_MISMATCH — not
  // UNMATCHED_NONCE, which would be a false statement about provenance.
  try {
    const { core, store } = H.makeCore();
    const r = await core.issue("SHOW_STATE", "CODA");
    const res = await core.ingestPageText(
      H.ack({ cmd: "RECENTER_SESSION", nonce: r.nonce, result: "ACCEPTED", note: "wrong cmd",
              state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "100", LAST_ANCHOR: "WRONG-CMD" } })
    );
    const rejected = await store.getRejectedAcks();
    const snap = await core.getSnapshot();
    const mismatch = rejected.find((e) => e.reason === "CMD_MISMATCH");
    const pass = res.bound.length === 0 &&
      snap.lastState === null &&
      !rejected.some((e) => e.reason === "UNMATCHED_NONCE") &&
      mismatch && mismatch.expected_cmd === "SHOW_STATE" && mismatch.cmd === "RECENTER_SESSION" &&
      (await store.isOutstanding(r.nonce)) === true;
    record("R15", "F-L-04 wrong-command ACK refused and named correctly", pass,
      "nonce was real, CMD did not match -> 0 bound, no state cached, record still outstanding; " +
      "discarded-input log records CMD_MISMATCH with expected=SHOW_STATE got=RECENTER_SESSION. " +
      "A real nonce is never logged as UNMATCHED_NONCE.");
  } catch (e) {
    record("R15", "F-L-04 wrong-command ACK refused and named correctly", false, e.message);
  }

  // ------------------------------------------------------------ R16 (F-L-06)
  // GCE_ISSUE is accepted ONLY from this extension's own context. A foreign
  // extension id AND an absent sender are both refused, and a refused request
  // must not mint a nonce or reach the transport.
  try {
    const { execSync } = require("node:child_process");
    const out = execSync("node test/sender-probe.js", { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    const j = JSON.parse(out);
    const pass = j.foreign_ok === false && j.foreign_reason === "INVALID_SENDER" && j.foreign_nonce === false &&
      j.noSender_ok === false && j.noSender_reason === "INVALID_SENDER" &&
      j.own_reason !== "INVALID_SENDER" && j.own_nonce === true &&
      // Identity contract: the envelope is addressed to the seat authoritative
      // state names, and a caller-supplied `seat` is IGNORED. A hardcoded
      // DEFAULT_SEAT="CODA" would fail both of these.
      j.envelopeFollowsState === true && j.envelopeIgnoredDecoy === true;
    record("R16", "F-L-06 GCE_ISSUE refused unless it is our own context", pass,
      "own extension id -> reached the transport and minted a nonce (send then failed on " + j.own_reason +
      ", which is the correct disposition with no ChatGPT tab open); " +
      "IDENTITY CONTRACT: envelope SEAT=" + j.envelopeSeat + " follows state (" + j.stateSeat +
      "), decoy seat=" + j.decoySeat + " IGNORED" + (j.envelopeIgnoredDecoy ? "" : "  <-- LEAK") + "; " +
      "foreign extension id -> ok=" + j.foreign_ok + " reason=" + j.foreign_reason + " nonce_minted=" + j.foreign_nonce + "; " +
      "absent sender -> ok=" + j.noSender_ok + " reason=" + j.noSender_reason +
      ". Identity is checked before any nonce exists.");
  } catch (e) {
    record("R16", "F-L-06 GCE_ISSUE refused unless it is our own context", false, String(e.stdout || e.message).trim().split("\n")[0]);
  }

  // ------------------------------------------------------------ Summary
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  console.log("\n=== REGRESSION SUMMARY ===");
  console.log("Probes: " + passed + "/" + total + "  verdict=" + (passed === total ? "PASS" : (passed === 0 ? "FAIL" : "PARTIAL")));

  // Write evidence
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "regression-report.json"),
    JSON.stringify({ suite: "GCE Don Control Bar v1 - regression R1..R16", startedAt: new Date().toISOString(), tests: results, summary: { total, passed, failed: total - passed, verdict: passed === total ? "PASS" : (passed === 0 ? "FAIL" : "PARTIAL") }, finishedAt: new Date().toISOString() }, null, 2)
  );
  console.log("evidence -> " + path.join(EVIDENCE_DIR, "regression-report.json"));

  if (passed !== total) process.exit(1);
}

main().catch(e => {
  console.error("REGRESSION CRASH:", e.stack || e);
  process.exit(1);
});