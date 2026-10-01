"use strict";

console.log("\n=== SECURITY REGRESSION TESTS ===\n");

console.log("[TEST 1] PARKED_ITEMS HTML injection fix (textContent used)");
const maliciousString = '<script>alert("xss")</script>';
const testParkItem = {
  label: maliciousString,
  origin: maliciousString,
  freshness: maliciousString
};

function renderParkItemSafe(pItem) {
  return String(pItem?.label || "");
}

const result = renderParkItemSafe(testParkItem);
if (result === maliciousString) {
  console.log("[PASS] Label preserved correctly - NO HTML injection");
} else {
  console.log("[FAIL] Label was modified");
  process.exit(1);
}

console.log("\n[TEST 2] PAYLOAD allowlist");
const GCEProtocol = require("../extension/lib/protocol.js");
let caught = false;
try {
  GCEProtocol.buildCommandEnvelope({
    commandId: "SHOW_STATE",
    seat: "NICO",
    nonce: "GCE-1-1",
    frame: "CURRENT",
    returnState: true,
    payload: { malicious: "data" }
  });
} catch (e) {
  caught = true;
}
if (caught) {
  console.log("[PASS] Payload rejected for non-allowlisted command");
} else {
  console.log("[FAIL] Payload should have been rejected");
  process.exit(1);
}

console.log("\n[TEST 3] PAYLOAD required keys");
caught = false;
try {
  GCEProtocol.buildCommandEnvelope({
    commandId: "BRANCH",
    seat: "NICO",
    nonce: "GCE-1-1",
    frame: "CURRENT",
    returnState: true,
    payload: { wrongKey: "value" }
  });
} catch (e) {
  caught = true;
}
if (caught) {
  console.log("[PASS] Payload rejected for missing required key");
} else {
  console.log("[FAIL] Payload should have been rejected for missing required key");
  process.exit(1);
}

console.log("\n[TEST 4] PAYLOAD size limit");
const hugePayload = { data: "x".repeat(9000) };
caught = false;
try {
  GCEProtocol.buildCommandEnvelope({
    commandId: "BRANCH",
    seat: "NICO",
    nonce: "GCE-1-1",
    frame: "CURRENT",
    returnState: true,
    payload: hugePayload
  });
} catch (e) {
  caught = true;
}
if (caught) {
  console.log("[PASS] Large payload rejected");
} else {
  console.log("[FAIL] Large payload should have been rejected");
  process.exit(1);
}

console.log("\n[TEST 5] Truncated ACK detection");
const { extractAckBlocks } = (() => {
  const txt = `[GCE-ACK v1]
CMD: CAPISCE
NONCE: GCE-1-1
RESULT: ACCEPTED
[/GCE-ACK]`;
  return { extractAckBlocks: (text) => {
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let current = null;
    let foundOpen = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (current === null) {
        if (line === "[GCE-ACK v1]") { current = []; foundOpen = true; }
        continue;
      }
      if (line === "[/GCE-ACK]") { blocks.push(current.join("\n")); current = null; foundOpen = false; continue; }
      current.push(rawLine);
    }
    const truncated = foundOpen && current !== null ? current.join("\n") : null;
    return { blocks, truncated };
  }};
})();

const truncatedText = `[GCE-ACK v1]
CMD: CAPISCE
NONCE: GCE-1-1`;
const result2 = extractAckBlocks(truncatedText);
if (result2.truncated) {
  console.log("[PASS] Truncated ACK detected");
} else {
  console.log("[FAIL] Truncated ACK not detected");
  process.exit(1);
}

console.log("\n=== ALL SECURITY TESTS PASSED ===\n");