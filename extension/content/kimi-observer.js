"use strict";

/*
 * GCE Don Control Bar — Kimi transport adapter (content script).
 *
 * Responsibilities (spec §7), and ONLY these:
 *   1. locate the active Kimi composer
 *   2. place the complete command envelope into it
 *   3. trigger send
 *   4. observe subsequent assistant output
 *
 * It has NO GCE vocabulary, no command semantics, no ACK parsing. It moves
 * text and reports text. ACK identification is the protocol layer's job.
 *
 * This file is SACRIFICIAL. If Kimi's DOM changes, this file is replaced.
 * Nothing else changes.
 *
 * ====================================================================
 * CB-02 — COMPOSER SAFETY. BINDING, NON-NEGOTIABLE.
 * ====================================================================
 * Don's unsent composer content is HIS. A control action must never destroy
 * it, never silently replace it, and must never report a successful send it
 * could not verify. Concretely, this module FAILS CLOSED:
 *
 *   - composer holds ANY text          -> do not inject. Do not click. Return
 *                                        COMPOSER_OCCUPIED. Zero mutation.
 *   - no usable send control          -> do not inject. Do not synthesise an
 *                                        Enter key. Return NO_SEND_CONTROL.
 *                                        (An unverifiable send is not a send.)
 *   - envelope not staged by the page -> undo the injection, return
 *                                        ENVELOPE_NOT_STAGED.
 *   - send did not clear the composer -> restore the exact pre-state and
 *                                        return SEND_NOT_CONFIRMED. Never
 *                                        report success.
 *   - click throws                    -> restore the exact pre-state, return
 *                                        SEND_THREW.
 *
 * The ONLY success path is: empty composer, real send control, click accepted,
 * composer verifiably cleared afterwards. Every result carries
 * `composerMutated` and `draftPreserved` so the caller never has to guess
 * whether Don's text survived.
 * ====================================================================
 */

(() => {
  const SELECTORS = {
    composer: [
      "textarea[placeholder*='发送']",
      "textarea[placeholder*='Message']",
      "textarea.kimi-input",
      "textarea[data-testid='chat-input']",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
      "form textarea",
      "textarea:not([disabled])"
    ],
    sendButton: [
      "button[type='submit']",
      "button[aria-label*='发送']",
      "button[aria-label*='Send']",
      "button[data-testid='send-button']",
      "button[data-testid='send']",
      "button[class*='send']",
      "button:contains('发送')",
      "button:contains('Send')"
    ],
    assistantTurn: [
      "[data-message-author='assistant']",
      "[data-role='assistant']",
      "article[data-testid*='message']",
      ".kimi-message",
      ".message-assistant"
    ]
  };

  const INJECT_SETTLE_MS = 60;
  const SEND_SETTLE_MS = 120;

  const FAILED = "FAILED_NOT_SENT";

  function firstMatch(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function allMatches(selectors) {
    for (const sel of selectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) return found;
    }
    return [];
  }

  function readComposer(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return String(el.value || "");
    return String(el.textContent || "");
  }

  function composerReady() {
    const el = firstMatch(SELECTORS.composer);
    return !!(el && !el.disabled);
  }

  function nativeSetValue(el, value) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
  }

  function findSendButton() {
    const btn = firstMatch(SELECTORS.sendButton);
    if (!btn) return null;
    if (btn.disabled) return null;
    if (btn.getAttribute("aria-disabled") === "true") return null;
    return btn;
  }

  function fail(error, mutated, preserved, extra) {
    return Object.assign({
      ok: false,
      error,
      disposition: FAILED,
      composerMutated: mutated === true,
      draftPreserved: preserved !== false
    }, extra || {});
  }

  async function sendEnvelope(envelope) {
    if (typeof envelope !== "string" || envelope.trim() === "") {
      return fail("EMPTY_ENVELOPE", false, true, { draftLength: 0 });
    }

    const composer = firstMatch(SELECTORS.composer);
    if (!composer || composer.disabled) {
      return fail("COMPOSER_NOT_FOUND", false, true, { draftLength: 0 });
    }

    const before = readComposer(composer);
    const draftLength = before.length;

    if (before.trim() !== "") {
      return fail("COMPOSER_OCCUPIED", false, true, {
        draftLength,
        note: "Unsent composer text present (" + draftLength +
              " chars). Command not injected, nothing sent, draft untouched."
      });
    }

    const btn = findSendButton();
    if (!btn) {
      return fail("NO_SEND_CONTROL", false, true, {
        draftLength: 0,
        note: "No enabled send control. Nothing injected, nothing sent."
      });
    }

    nativeSetValue(composer, envelope);
    composer.focus();
    await new Promise((r) => setTimeout(r, INJECT_SETTLE_MS));

    const staged = readComposer(composer);
    if (staged.trim() === "") {
      return fail("ENVELOPE_NOT_STAGED", true, true, {
        draftLength: 0,
        note: "Page did not retain the injected command. Nothing was sent."
      });
    }

    const method = "button-click";
    try {
      btn.click();
    } catch (e) {
      nativeSetValue(composer, before);
      return fail("SEND_THREW", true, true, {
        method,
        restored: true,
        draftLength: 0,
        note: "Send control threw. Composer restored to its pre-command state."
      });
    }

    await new Promise((r) => setTimeout(r, SEND_SETTLE_MS));

    const after = readComposer(composer);
    if (after.trim() === "") {
      return {
        ok: true,
        method,
        clearedComposer: true,
        composerMutated: true,
        draftPreserved: true,
        draftLength: 0
      };
    }

    if (after === staged) {
      nativeSetValue(composer, before);
      return fail("SEND_NOT_CONFIRMED", true, true, {
        method,
        restored: true,
        draftLength: 0,
        note: "Command remained in the composer after send. Composer restored; " +
              "send NOT reported as successful."
      });
    }

    return fail("COMPOSER_CHANGED_EXTERNALLY", true, true, {
      method,
      restored: false,
      draftLength: 0,
      note: "Composer changed after send and does not match the staged command. " +
            "Left untouched on purpose. Send NOT reported as successful."
    });
  }

  /* DON CORRECTION (1.7.4) - same ruling as chatgpt-observer.js: scan the WHOLE
   * conversation, accept several spellings, parse the gce.routing footer. The
   * old version read one turn for three literal KEY: lines and so never
   * populated observed state during a real session. */
  /* DON CORRECTION (1.7.8) - observed state comes ONLY from assistant turns.
   * The old fallback scraped document.querySelector("main"), which is the WHOLE
   * page: on a new chat that is the Recents sidebar, Don's own prompt and UI
   * placeholder strings. A chat title was reported as the objective and the
   * literal word "blank" as SEAT/MODE. No assistant turn means no seat has
   * spoken, so there is nothing honest to report. */
  function observe() {
    const turns = allMatches(SELECTORS.assistantTurn);
    if (turns.length === 0) {
      return { text: "", turnCount: 0, observed: null, chromeText: chromeText() };
    }
    const allText = turns.map(t => t.innerText || t.textContent || "").join("\n");
    return { text: allText, turnCount: turns.length, observed: extractObservedState(allText) };
  }

  // Page text, used ONLY for ACK ingestion. Never for observed state.
  function chromeText() {
    const main = document.querySelector("main");
    return main ? main.innerText || "" : "";
  }

  const SEAT_VOCAB = [
    "Coda", "Vittorio", "Chiave", "Nico", "Corrado", "Falcon", "Talon",
    "Keel", "Luce", "Magpie", "Pigeon", "Raven", "Enzo", "Serafina"
  ];

  /* DON CORRECTION (1.7.8) - reject UI placeholder values. "None" is NOT
   * rejected: "Blockers: None" is a real answer. */
  const PLACEHOLDER_VALUES = new Set([
    "blank", "empty", "undefined", "null", "nan", "n/a", "na",
    "placeholder", "none set", "not set", "unknown", "tbd", "todo",
    "-", "--", "...", "…"
  ]);

  function isPlaceholder(v) {
    if (!v) return true;
    const n = String(v).trim().toLowerCase().replace(/[.\s]+$/, "");
    return n === "" || PLACEHOLDER_VALUES.has(n);
  }

  function field(text, labels) {
    for (const l of labels) {
      const re = new RegExp("^[ \\t>*_-]*(?:" + l + ")[ \\t]*[:=][ \\t]*(.+?)\\s*$", "im");
      const m = text.match(re);
      if (m && m[1]) {
        const v = m[1].replace(/^["'`]+|["'`,]+$/g, "").trim();
        if (v && !isPlaceholder(v)) return v;
      }
    }
    return null;
  }

  function parseRoutingFooter(text) {
    const fence = /```gce\.routing\s*([\s\S]*?)```/gi;
    let m, last = null;
    while ((m = fence.exec(text)) !== null) {
      try { last = JSON.parse(m[1]); } catch (_) { /* ignore */ }
    }
    return last && typeof last === "object" ? last : null;
  }

  /* DON CORRECTION (1.7.5) - two ingestion forms, same ruling as chatgpt-observer:
   * the label:value SESSION HEADER is primary (Primary Seat / Mode / Status /
   * Objective / Next Action), the gce.routing footer is second. Header wins on
   * conflict. Seat is stripped of its role suffix. */
  function extractObservedState(text) {
    if (!text || !text.trim()) return null;
    const routing = parseRoutingFooter(text);

    let seat = field(text, ["SEAT", "Primary seat", "current_seat", "CURRENT_SEAT", "Identity"]);
    if (seat) seat = bareSeat(seat);
    if (!seat && routing && routing.current_seat) seat = bareSeat(routing.current_seat);

    let mode = field(text, ["MODE", "mode"]);
    if (!mode && routing && routing.session_status) mode = routing.session_status;

    const status = field(text, ["STATUS", "Status", "Session status", "SESSION_STATUS", "session_status"]);

    let objective = field(text, ["OBJECTIVE", "objective", "Current Task", "CURRENT_TASK"]);
    if (!objective) objective = field(text, ["Current Anchor", "CURRENT_ANCHOR", "Anchor", "ANCHOR"]);
    if (!objective && routing && routing.current_anchor) objective = routing.current_anchor;

    const project = field(text, ["PROJECT", "project"]) || (routing && routing.project) || null;
    const workstream = field(text, ["WORKSTREAM", "workstream"]) || (routing && routing.workstream) || null;
    const nextAction = field(text, ["Next Action", "NEXT_ACTION", "NEXT_ROUTE", "Next Route", "next_route"])
      || (routing && routing.next_route) || null;
    const blockers = field(text, ["BLOCKERS", "Blockers", "blocker_route", "Blocker Route"]);
    const donIntent = field(text, ["Don Intent", "DON_INTENT"]);
    const evidence = field(text, ["EVIDENCE", "Evidence"]);

    /* DON CORRECTION (1.7.6) - prose fallback, as chatgpt-observer.js. 1.7.5
     * dropped it while adding the two-form header ingest, so a working session
     * with no "Primary Seat:" line rendered SEAT as "-". Last mention wins. */
    if (!seat) seat = seatFromProse(text);

    if (!seat && !mode && !objective && !project && !workstream && !nextAction &&
        !blockers && !donIntent && !evidence && !status) return null;
    return {
      SEAT: seat, MODE: mode, STATUS: status, OBJECTIVE: objective,
      PROJECT: project, WORKSTREAM: workstream,
      NEXT_ACTION: nextAction, BLOCKERS: blockers,
      DON_INTENT: donIntent, EVIDENCE: evidence
    };
  }

/* "Enzo - Executive Integrator / Organizational Operator" is a seat plus a
   * role. The strip shows the seat. */
  function bareSeat(raw) {
    if (!raw) return null;
    if (isPlaceholder(raw)) return null;
    const first = String(raw).split(/\s+[-–—]\s+/)[0].trim();
    if (!first || isPlaceholder(first)) return null;
    return first;
  }

  /* DON CORRECTION (1.7.6) - seat from prose. Last mention wins; only registry
   * seats match, so no identity is ever invented. */
  function seatFromProse(text) {
    if (!text) return null;
    /* Scan by position, as chatgpt-observer.js: the most recent mention in the
     * TEXT wins. Iterating the vocabulary instead made list order, not the
     * conversation, decide who appeared to be driving. */
    let best = null, bestAt = -1;
    for (const s of SEAT_VOCAB) {
      const re = new RegExp("(^|[^A-Za-z])" + s + "([^A-Za-z]|$)", "g");
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > bestAt) { bestAt = m.index; best = s; }
      }
    }
    return best;
  }

  /* DON CORRECTION (1.7.4) — same ruling as chatgpt-observer.js: staging is an
   * explicit operator act. A held draft must not make the button a silent
   * no-op ("composer occupied"). Overwrite, and report what was overwritten. */
  async function stageBootstrap(text) {
    const composer = firstMatch(SELECTORS.composer);
    if (!composer || composer.disabled) return { ok: false, error: "COMPOSER_NOT_FOUND" };
    const before = readComposer(composer);
    const replacedDraftLength = before.trim() === "" ? 0 : before.length;
    nativeSetValue(composer, text);
    composer.focus();
    await new Promise((r) => setTimeout(r, INJECT_SETTLE_MS));
    const staged = readComposer(composer);
    if (staged.trim() === "") return { ok: false, error: "ENVELOPE_NOT_STAGED" };
    return {
      ok: true,
      replacedDraftLength,
      note: replacedDraftLength > 0
        ? "staged (replaced " + replacedDraftLength + "-char draft) — review, press Enter"
        : "staged — review composer, press Enter"
    };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return undefined;
    if (msg.type === "GCE_SEND_ENVELOPE") {
      return sendEnvelope(msg.envelope).then((r) => ({ ...r, type: "GCE_SEND_ENVELOPE_RESULT" }));
    }
    if (msg.type === "GCE_OBSERVE") {
      const r = observe();
      return Promise.resolve({ ...r, type: "GCE_OBSERVE_RESULT" });
    }
    if (msg.type === "GCE_BOOTSTRAP") {
      return stageBootstrap(msg.text).then((r) => ({ ...r, type: "GCE_BOOTSTRAP_RESULT" }));
    }
    if (msg.type === "GCE_PING") {
      return Promise.resolve({ ok: true, composerReady: composerReady(), type: "GCE_PING_RESULT" });
    }
    if (msg.type === "GCE_FINDINGS_WRITTEN") {
      // Notify Don that findings were written
      alert("GCE FINDINGS WRITTEN\n\nFile: " + msg.filename + "\n\nClick OK to download.");
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  try {
    browser.runtime.sendMessage({ type: "GCE_CONTENT_READY", href: location.href });
  } catch (_) { /* background may not be listening yet; harmless */ }
})();