"use strict";

/*
 * Reproduction script for Luce findings F-L-01, F-L-02, F-L-03
 * Run: node test/reproduce-defects.js
 */

const H = require("./harness/env.js");

async function reproFL01_NonceReplay() {
  console.log("\n=== F-L-01: Nonce Replay ===");
  const { core, store } = H.makeCore({ sentTimeoutMs: 30000 });
  
  // Issue a command
  const r = await core.issue("SHOW_STATE", "CODA");
  const nonce = r.nonce;
  console.log("Issued nonce:", nonce);
  
  // Bind a genuine ACK
  const ack1 = H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "real", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "50", LAST_ANCHOR: "real-1" } });
  await core.ingestPageText(ack1);
  
  const stateBefore = (await core.getSnapshot()).lastState;
  console.log("After first bind - CONFIDENCE:", stateBefore.state.CONFIDENCE, "ANCHOR:", stateBefore.state.LAST_ANCHOR);
  
  // Check nonce is still outstanding
  const outstandingBefore = await store.getOutstanding();
  console.log("Nonce still outstanding after bind?:", !!outstandingBefore[nonce]);
  
  // REPLAY the same ACK (simulate re-observation)
  const ack2 = H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "replay", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "100", LAST_ANCHOR: "FORGED-ANCHOR" } });
  await core.ingestPageText(ack2);
  
  const stateAfter = (await core.getSnapshot()).lastState;
  console.log("After replay - CONFIDENCE:", stateAfter.state.CONFIDENCE, "ANCHOR:", stateAfter.state.LAST_ANCHOR);
  
  const outstandingAfter = await store.getOutstanding();
  console.log("Nonce still outstanding after replay?:", !!outstandingAfter[nonce]);
  
  const ackLog = await store.getAckLog();
  console.log("ackLog length:", ackLog.length);
  
  const replayMutated = stateAfter.state.CONFIDENCE === "100" && stateAfter.state.LAST_ANCHOR === "FORGED-ANCHOR";
  console.log("REPLAY MUTATED STATE:", replayMutated);
  return replayMutated;
}

async function reproFL02_RepeatedAckIngestion() {
  console.log("\n=== F-L-02: Repeated ACK Ingestion ===");
  const { core, store } = H.makeCore({ sentTimeoutMs: 30000 });
  
  const r = await core.issue("SHOW_STATE", "CODA");
  const nonce = r.nonce;
  
  const ack = H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "ok", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "77", LAST_ANCHOR: "anchor-1" } });
  
  // First ingestion
  await core.ingestPageText(ack);
  let snap1 = await core.getSnapshot();
  console.log("After 1st ingestion - ackLog:", (await store.getAckLog()).length, "receivedAt:", snap1.lastState.receivedAt, "stateAgeMs:", snap1.stateAgeMs);
  
  // Second ingestion (same text)
  await core.ingestPageText(ack);
  let snap2 = await core.getSnapshot();
  console.log("After 2nd ingestion - ackLog:", (await store.getAckLog()).length, "receivedAt:", snap2.lastState.receivedAt, "stateAgeMs:", snap2.stateAgeMs);
  
  // Third ingestion
  await core.ingestPageText(ack);
  let snap3 = await core.getSnapshot();
  console.log("After 3rd ingestion - ackLog:", (await store.getAckLog()).length, "receivedAt:", snap3.lastState.receivedAt, "stateAgeMs:", snap3.stateAgeMs);
  
  const ackLogLen = (await store.getAckLog()).length;
  const receivedAtRefreshed = snap3.lastState.receivedAt > snap1.lastState.receivedAt;
  const stateAgeZero = snap3.stateAgeMs < 100; // effectively zero
  
  console.log("ackLog flooded:", ackLogLen > 1);
  console.log("receivedAt refreshed on duplicate:", receivedAtRefreshed);
  console.log("STATE AGE near zero:", stateAgeZero);
  
  return { ackLogFlooded: ackLogLen > 1, receivedAtRefreshed, stateAgeZero };
}

async function reproFL03_UnreachableFailedState() {
  console.log("\n=== F-L-03: FAILED_SENT_UNCONFIRMED Reachable ===");
  const { core, store } = H.makeCore({ sentTimeoutMs: 100 }); // Short timeout for test
  
  // Issue command - goes to SENT (fake adapter succeeds)
  const r = await core.issue("SHOW_STATE", "CODA");
  const nonce = r.nonce;
  console.log("After issue - topState:", (await core.getSnapshot()).topState);
  
  // Check outstanding record is SENT
  let outstanding = await store.getOutstanding();
  console.log("Outstanding record status:", outstanding[nonce].status);
  
  // Wait for timeout
  await new Promise(resolve => setTimeout(resolve, 150));
  
  // Call checkTimeouts (the new timeout path)
  const changed = await core.checkTimeouts();
  console.log("checkTimeouts changed:", changed);
  
  // Check status changed to FAILED_SENT_UNCONFIRMED
  outstanding = await store.getOutstanding();
  console.log("After checkTimeouts - status:", outstanding[nonce].status);
  
  const snap = await core.getSnapshot();
  console.log("topState:", snap.topState);
  
  const pass = outstanding[nonce].status === "FAILED_SENT_UNCONFIRMED" && snap.topState === "FAILED_SENT_UNCONFIRMED";
  console.log("FAILED_SENT_UNCONFIRMED REACHABLE:", pass);
  
  return pass;
}

async function main() {
  console.log("Running Luce defect reproductions...\n");
  
  const fl01 = await reproFL01_NonceReplay();
  const fl02 = await reproFL02_RepeatedAckIngestion();
  const fl03 = await reproFL03_UnreachableFailedState();
  
  console.log("\n=== SUMMARY ===");
  console.log("F-L-01 (nonce replay mutates state):", fl01 ? "DEFECT PRESENT" : "FIXED");
  console.log("F-L-02 (repeated ACK floods log, refreshes receivedAt, kills stateAge):", 
    fl02.ackLogFlooded || fl02.receivedAtRefreshed ? "DEFECT PRESENT" : "FIXED");
  console.log("F-L-03 (FAILED_SENT_UNCONFIRMED reachable via checkTimeouts):", fl03 ? "FIXED" : "DEFECT PRESENT");
}

main().catch(e => {
  console.error("REPRO CRASH:", e.stack || e);
  process.exit(1);
});