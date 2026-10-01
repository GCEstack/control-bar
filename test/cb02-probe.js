"use strict";

/*
 * CB-02 SAFETY PROBE - Don's unsent composer text.
 * Run: node test/cb02-probe.js
 *
 * HARD INVARIANT under test:
 *   A GCE control action MUST NEVER DESTROY OR SILENTLY REPLACE Don's unsent
 *   composer content. If safe command submission cannot be guaranteed, the
 *   transport FAILS CLOSED, preserves the draft, and must NOT report a
 *   successful clearing when the envelope or the original draft remains.
 *
 * Every assertion below runs the SHIPPED content/chatgpt-observer.js in a vm
 * context (see harness/dom.js). Nothing here re-implements the script.
 *
 * Mode:
 *   node test/cb02-probe.js                     -> verify the fix; exit 1 on any FAIL
 *   node test/cb02-probe.js --expect-defect     -> assert the defects are PRESENT
 *                                                   (pre-fix evidence; same 8 cases)
 */

const fs = require("node:fs");
const path = require("node:path");
const DOM = require("./harness/dom.js");

const EVIDENCE_DIR = path.join(__dirname, "..", "evidence");
const EXPECT_DEFECT = process.argv.includes("--expect-defect");

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log("[" + (pass ? "PASS" : "FAIL") + "] " + id + " - " + name);
  if (detail) console.log("       " + String(detail).replace(/\n/g, "\n       "));
}

const ENVELOPE = [
  "[GCE-CMD v1]",
  "CMD: SHOW_STATE",
  "SEAT: CODA",
  "NONCE: GCE-1700000000000-1",
  "FRAME: CURRENT",
  "RETURN_STATE: TRUE",
  "[/GCE-CMD]"
].join("\n");

const DRAFT = "Don: hold the football lane, do not reopen Cable Car, and tell me what breaks";

function composerText(el) {
  return el.tagName === "TEXTAREA" ? el.value : el.textContent;
}

async function main() {
  console.log("=== CB-02 COMPOSER SAFETY PROBE ===" +
    (EXPECT_DEFECT ? "  (--expect-defect: defects must be PRESENT)" : "  (verify-fix mode)") + "\n");

  // ----------------------------------------------------------------- C1
  // EMPTY composer + working send control -> the only safe, fully verified path.
  try {
    const composer = DOM.makeComposer("textarea", { text: "" });
    const btn = DOM.makeSendButton({ composer, clearsOnClick: true });
    const o = await DOM.loadObserver({ composer, sendButton: btn });
    const r = await o.send(ENVELOPE);
    const pass = r.ok === true && r.clearedComposer === true && btn.clicks === 1 && composerText(composer) === "";
    record("C1", "Empty composer: verified send succeeds", pass,
      "ok=" + r.ok + " clearedComposer=" + r.clearedComposer + " clicks=" + btn.clicks +
      " method=" + r.method + " -> command reached the page, composer verifiably empty.");
  } catch (e) {
    record("C1", "Empty composer: verified send succeeds", false, e.message);
  }

  // ----------------------------------------------------------------- C2
  // OCCUPIED composer (textarea path). Don has typed something unsent.
  try {
    const composer = DOM.makeComposer("textarea", { text: DRAFT });
    const btn = DOM.makeSendButton({ composer, clearsOnClick: true });
    const o = await DOM.loadObserver({ composer, sendButton: btn });
    const r = await o.send(ENVELOPE);
    const after = composerText(composer);
    const destroyed = r.ok === true && btn.clicks >= 1 && after !== DRAFT;
    const fixed = r.ok === false && after === DRAFT && btn.clicks === 0 &&
      r.composerMutated === false && r.draftPreserved === true;
    const pass = EXPECT_DEFECT ? destroyed : fixed;
    record("C2", "Occupied composer (textarea): draft never destroyed", pass,
      (EXPECT_DEFECT ? "[DEFECT REPRODUCED] " : "") +
      "ok=" + r.ok + " error=" + r.error +
      "\ndraft_unchanged=" + (after === DRAFT) + "  send_clicks=" + btn.clicks +
      "  composerMutated=" + r.composerMutated + "  draftPreserved=" + r.draftPreserved +
      "\ncomposer_after=" + JSON.stringify(after));
  } catch (e) {
    record("C2", "Occupied composer (textarea): draft never destroyed", false, e.message);
  }

  // ----------------------------------------------------------------- C3
  // OCCUPIED composer on the contenteditable path (the live ChatGPT shape).
  try {
    const composer = DOM.makeComposer("contenteditable", { text: DRAFT });
    const btn = DOM.makeSendButton({ composer, clearsOnClick: true });
    const o = await DOM.loadObserver({ composer, sendButton: btn });
    const r = await o.send(ENVELOPE);
    const after = composerText(composer);
    const destroyed = r.ok === true && btn.clicks >= 1 && after !== DRAFT;
    const fixed = r.ok === false && after === DRAFT && btn.clicks === 0 && r.draftPreserved === true;
    const pass = EXPECT_DEFECT ? destroyed : fixed;
    record("C3", "Occupied composer (contenteditable): draft never destroyed", pass,
      (EXPECT_DEFECT ? "[DEFECT REPRODUCED] " : "") +
      "ok=" + r.ok + " error=" + r.error + " draft_unchanged=" + (after === DRAFT) +
      " send_clicks=" + btn.clicks + " composer_after=" + JSON.stringify(after));
  } catch (e) {
    record("C3", "Occupied composer (contenteditable): draft never destroyed", false, e.message);
  }

  // ----------------------------------------------------------------- C4
  // FAILED SEND - the send control does not clear the composer, so the
  // envelope is still sitting there afterwards.
  try {
    const composer = DOM.makeComposer("textarea", { text: "" });
    const btn = DOM.makeSendButton({ composer, clearsOnClick: false });
    const o = await DOM.loadObserver({ composer, sendButton: btn });
    const r = await o.send(ENVELOPE);
    const after = composerText(composer);
    const envelopeLeftBehind = after.indexOf("GCE-CMD v1") !== -1;
    const pass = EXPECT_DEFECT
      ? (r.ok === true && envelopeLeftBehind)
      : (r.ok === false && !envelopeLeftBehind && r.draftPreserved === true);
    record("C4", "Failed send: reported as failure, composer restored", pass,
      (EXPECT_DEFECT ? "[DEFECT REPRODUCED] " : "") +
      "ok=" + r.ok + " clearedComposer=" + r.clearedComposer + " error=" + r.error +
      "\nenvelope_left_in_composer=" + envelopeLeftBehind + " restored=" + r.restored +
      "\ncomposer_after=" + JSON.stringify(after));
  } catch (e) {
    record("C4", "Failed send: reported as failure, composer restored", false, e.message);
  }

  // ----------------------------------------------------------------- C5
  // NO SEND CONTROL AVAILABLE. v1 fell back to a synthetic Enter keydown, whose
  // effect cannot be verified. Expect fail closed BEFORE any DOM contact.
  try {
    const composer = DOM.makeComposer("textarea", { text: "" });
    const o = await DOM.loadObserver({ composer, sendButton: null });
    const r = await o.send(ENVELOPE);
    const after = composerText(composer);
    const pass = EXPECT_DEFECT
      ? (r.ok === true && r.method === "enter-key")
      : (r.ok === false && after === "" && r.composerMutated === false);
    record("C5", "No send control: fail closed before any mutation", pass,
      (EXPECT_DEFECT ? "[DEFECT REPRODUCED] " : "") +
      "ok=" + r.ok + " error=" + r.error + " method=" + r.method +
      " composer_after=" + JSON.stringify(after) + " composerMutated=" + r.composerMutated);
  } catch (e) {
    record("C5", "No send control: fail closed before any mutation", false, e.message);
  }

  // ----------------------------------------------------------------- C6
  // OCCUPIED composer AND a send control that does not work. Worst case: the
  // draft is replaced and the replacement is stranded in the composer.
  try {
    const composer = DOM.makeComposer("textarea", { text: DRAFT });
    const btn = DOM.makeSendButton({ composer, clearsOnClick: false });
    const o = await DOM.loadObserver({ composer, sendButton: btn });
    const r = await o.send(ENVELOPE);
    const after = composerText(composer);
    const draftLost = after !== DRAFT;
    const pass = EXPECT_DEFECT ? (r.ok === true && draftLost) : (r.ok === false && after === DRAFT);
    record("C6", "Occupied + non-clearing send control: draft still survives", pass,
      (EXPECT_DEFECT ? "[DEFECT REPRODUCED] " : "") +
      "ok=" + r.ok + " error=" + r.error + " draft_unchanged=" + (after === DRAFT) +
      " send_clicks=" + btn.clicks + " composer_after=" + JSON.stringify(after));
  } catch (e) {
    record("C6", "Occupied + non-clearing send control: draft still survives", false, e.message);
  }

  // ----------------------------------------------------------------- C7
  // EMPTY / malformed envelope must be rejected before any DOM contact.
  try {
    const composer = DOM.makeComposer("textarea", { text: "" });
    const btn = DOM.makeSendButton({ composer, clearsOnClick: true });
    const o = await DOM.loadObserver({ composer, sendButton: btn });
    const r = await o.send("");
    const pass = EXPECT_DEFECT
      ? (r.ok === true && btn.clicks >= 1)
      : (r.ok === false && btn.clicks === 0 && composerText(composer) === "");
    record("C7", "Empty envelope rejected before any DOM mutation", pass,
      (EXPECT_DEFECT ? "[DEFECT REPRODUCED] " : "") +
      "ok=" + r.ok + " error=" + r.error + " send_clicks=" + btn.clicks);
  } catch (e) {
    record("C7", "Empty envelope rejected before any DOM mutation", false, e.message);
  }

  // ----------------------------------------------------------------- C8
  // NO COMPOSER AT ALL. Must fail closed with a typed reason, must not throw.
  try {
    const o = await DOM.loadObserver({ composer: null, sendButton: null });
    const r = await o.send(ENVELOPE);
    const pass = r.ok === false && typeof r.error === "string" && r.error.length > 0;
    record("C8", "Missing composer: typed failure, no throw", pass,
      "ok=" + r.ok + " error=" + r.error);
  } catch (e) {
    record("C8", "Missing composer: typed failure, no throw", false, e.message);
  }

  // ---------------------------------------------------------------- summary
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const verdict = passed === total ? "PASS" : (passed === 0 ? "FAIL" : "PARTIAL");
  console.log("\n=== CB-02 SUMMARY ===");
  console.log("Cases: " + passed + "/" + total + "  verdict=" + verdict +
    (EXPECT_DEFECT ? "  (defect-reproduction mode)" : ""));

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "cb02-composer-safety-report.json"),
    JSON.stringify({
      suite: "CB-02 composer safety - shipped content/chatgpt-observer.js",
      mode: EXPECT_DEFECT ? "expect-defect" : "verify-fix",
      note: "Every case loads the SHIPPED content script in a vm context (harness/dom.js). No re-implementation.",
      startedAt: new Date().toISOString(),
      tests: results,
      summary: { total, passed, failed: total - passed, verdict }
    }, null, 2)
  );
  console.log("evidence -> " + path.join(EVIDENCE_DIR, "cb02-composer-safety-report.json"));

  if (!EXPECT_DEFECT && passed !== total) process.exit(1);
}

main().catch((e) => {
  console.error("CB-02 PROBE CRASH:", e && e.stack ? e.stack : e);
  process.exit(1);
});
