"use strict";

/*
 * Test F-L-03 fix: SENT -> FAILED_SENT_UNCONFIRMED timeout
 */

const H = require("./harness/env.js");

async function testTimeout() {
  const { core, store } = H.makeCore({ sentTimeoutMs: 100 }); // 100ms timeout for test
  
  // Issue a command - goes to SENT (fake adapter succeeds)
  const r = await core.issue("SHOW_STATE", "CODA");
  const nonce = r.nonce;
  console.log("After issue - topState:", (await core.getSnapshot()).topState);
  
  // Check outstanding record is SENT
  let outstanding = await store.getOutstanding();
  console.log("Outstanding record:", JSON.stringify(outstanding[nonce], null, 2));
  
  // Wait for timeout
  await new Promise(resolve => setTimeout(resolve, 150));
  
  // Call checkTimeouts
  const changed = await core.checkTimeouts();
  console.log("checkTimeouts changed:", changed);
  
  // Check status changed to FAILED_SENT_UNCONFIRMED
  outstanding = await store.getOutstanding();
  console.log("After checkTimeouts - outstanding:", JSON.stringify(outstanding[nonce], null, 2));
  
  const snap = await core.getSnapshot();
  console.log("topState:", snap.topState);
  
  const pass = outstanding[nonce].status === "FAILED_SENT_UNCONFIRMED" && snap.topState === "FAILED_SENT_UNCONFIRMED";
  console.log("TEST:", pass ? "PASS" : "FAIL");
}

testTimeout().catch(e => console.error(e.stack || e));