"use strict";

function normalizeSnapshot(snap) {
  if (!snap) return {};
  const raw = snap.lastState?.state || {};
  let parkedItems = raw.PARKED_ITEMS;
  if (typeof parkedItems === "string" && parkedItems.trim()) {
    try {
      const parsed = JSON.parse(parkedItems);
      parkedItems = Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      parkedItems = null;
    }
  }
  return {
    ...raw,
    PARKED_ITEMS: parkedItems,
    topState: snap.topState,
    session: snap.session,
    stateAgeMs: snap.stateAgeMs,
    outstandingCount: snap.outstandingCount,
    latest: snap.latest
  };
}

const realBackgroundSnapshot = {
  topState: "IDLE",
  session: { closed: false },
  controls: [],
  lastState: {
    state: {
      PRIMARY_SEAT: "Coda",
      MODE: "VERIFICATION",
      STATE_FRESHNESS: "CURRENT",
      CURRENT_BRANCH: "feature/snapshot-contract",
      SESSION_ID: "20260930-NICO-1",
      CURRENT_TASK: "verify v1.3.2",
      CONFIDENCE: "92",
      CURRENT_ANCHOR: "EC8 / Parent Quant build lane",
      PROMOTED_CURRENT: "v1.3.1 repair",
      BLOCKERS: "0",
      STATE_AS_OF: "2026-09-30T14:30:00Z",
      PARKED_ITEMS: JSON.stringify([
        { label: "explore-alternative", origin: "feature/alt", freshness: "STALE", identity: "park-001" }
      ])
    },
    receivedAt: 1758999999000,
    nonce: "GCE-1758999999-1",
    commandId: "SHOW_STATE"
  },
  stateAgeMs: 1000,
  latest: null,
  outstandingCount: 0
};

const normalized = normalizeSnapshot(realBackgroundSnapshot);

const assertions = [
  { name: "PRIMARY_SEAT", actual: normalized.PRIMARY_SEAT, expected: "Coda" },
  { name: "MODE", actual: normalized.MODE, expected: "VERIFICATION" },
  { name: "STATE_FRESHNESS", actual: normalized.STATE_FRESHNESS, expected: "CURRENT" },
  { name: "CURRENT_BRANCH", actual: normalized.CURRENT_BRANCH, expected: "feature/snapshot-contract" },
  { name: "SESSION_ID", actual: normalized.SESSION_ID, expected: "20260930-NICO-1" },
  { name: "CURRENT_TASK", actual: normalized.CURRENT_TASK, expected: "verify v1.3.2" },
  { name: "CONFIDENCE", actual: normalized.CONFIDENCE, expected: "92" },
  { name: "CURRENT_ANCHOR", actual: normalized.CURRENT_ANCHOR, expected: "EC8 / Parent Quant build lane" },
  { name: "PROMOTED_CURRENT", actual: normalized.PROMOTED_CURRENT, expected: "v1.3.1 repair" },
  { name: "BLOCKERS", actual: normalized.BLOCKERS, expected: "0" },
  { name: "STATE_AS_OF", actual: normalized.STATE_AS_OF, expected: "2026-09-30T14:30:00Z" },
  { name: "PARKED_ITEMS is array", actual: Array.isArray(normalized.PARKED_ITEMS), expected: true },
  { name: "PARKED_ITEMS[0].label", actual: normalized.PARKED_ITEMS?.[0]?.label, expected: "explore-alternative" }
];

let passed = 0, failed = 0;
console.log("\n=== REAL HANDSHAKE FIDELITY TEST ===\n");

for (const a of assertions) {
  const ok = a.actual === a.expected;
  if (ok) {
    passed++;
    console.log(`[PASS] ${a.name}: ${a.actual}`);
  } else {
    failed++;
    console.log(`[FAIL] ${a.name}: got "${a.actual}", expected "${a.expected}"`);
  }
}

console.log(`\n=== RESULTS: ${passed}/${passed + failed} PASSED ===\n`);

if (failed > 0) {
  process.exit(1);
}