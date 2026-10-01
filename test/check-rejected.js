"use strict";

/*
 * Check F-L-02 rejectedAcks after F-L-01 fix
 */

const H = require("./harness/env.js");

async function checkRejectedAcks() {
  const { core, store } = H.makeCore();
  
  const r = await core.issue("SHOW_STATE", "CODA");
  const nonce = r.nonce;
  
  const ack = H.ack({ cmd: "SHOW_STATE", nonce, result: "ACCEPTED", note: "ok", state: { SEAT: "Coda", STATUS: "ACTIVE", CONFIDENCE: "77", LAST_ANCHOR: "anchor-1" } });
  
  await core.ingestPageText(ack);
  console.log("After 1st ingestion - ackLog:", (await store.getAckLog()).length, "rejected:", (await store.getRejectedAcks()).length);
  
  await core.ingestPageText(ack);
  console.log("After 2nd ingestion - ackLog:", (await store.getAckLog()).length, "rejected:", (await store.getRejectedAcks()).length);
  
  await core.ingestPageText(ack);
  console.log("After 3rd ingestion - ackLog:", (await store.getAckLog()).length, "rejected:", (await store.getRejectedAcks()).length);
  
  const rej = await store.getRejectedAcks();
  console.log("Rejected reasons:", rej.map(r => r.reason));
}

checkRejectedAcks().catch(e => console.error(e.stack || e));