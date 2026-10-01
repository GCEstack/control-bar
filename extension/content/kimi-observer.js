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

  function observe() {
    const turns = allMatches(SELECTORS.assistantTurn);
    if (turns.length === 0) {
      const main = document.querySelector("main") || document.body;
      return { text: main ? main.innerText || "" : "", turnCount: 0 };
    }
    const last = turns[turns.length - 1];
    return { text: last.innerText || last.textContent || "", turnCount: turns.length };
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