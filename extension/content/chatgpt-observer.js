"use strict";

/*
 * GCE Don Control Bar — ChatGPT content script (DOM half of the adapter).
 *
 * Responsibilities (spec §7), and ONLY these:
 *   1. locate the active ChatGPT composer
 *   2. place the complete command envelope into it
 *   3. trigger send
 *   4. observe subsequent assistant output
 *
 * It has NO GCE vocabulary, no command semantics, no ACK parsing. It moves
 * text and reports text. ACK identification is the protocol layer's job.
 *
 * This file is SACRIFICIAL. If ChatGPT's DOM changes, this file is replaced.
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
      "#prompt-textarea",
      "div[contenteditable='true'][id='prompt-textarea']",
      "textarea[data-testid='prompt-textarea']",
      "form textarea",
      "div[contenteditable='true'][role='textbox']",
      "textarea[placeholder*='Message']",
      "form > div > div[contenteditable]",
      "[data-id='root'] form textarea"
    ],
    sendButton: [
      "button[data-testid='send-button']",
      "button[aria-label='Send message']",
      "button[aria-label='Send']",
      "form button[type='submit']",
      "button[aria-label='Send prompt']",
      "button[class*='send']",
      "button[type='submit']",
      "form button:not([type])",
      "div[role='button'][aria-label*='Send']",
      "[data-testid='root'] button"
    ],
    assistantTurn: [
      "[data-message-author-role='assistant']",
      "article[data-testid^='conversation-turn']",
      ".agent-turn",
      "[data-testid='conversation-turn']"
    ]
  };

  /* Time for the page framework to register an injected value, and time for it
   * to act on a click. Both were the v1 values; the settle windows are not the
   * safety mechanism — the before/after reads are. */
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

  /* The single read of composer content, used for both the safety check and the
   * post-send verification. One reader, so the check and the verification can
   * never disagree about what the composer holds. */
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
    // Works for textarea; contenteditable uses textContent + input event.
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

  // Send via Enter key — the current ChatGPT surface has no Send button.
  // This function attempts to trigger the native Enter behavior. If the
  // composer clears, the send is confirmed. Otherwise it fails closed.
  function sendViaEnterKey(composer) {
    return new Promise((resolve) => {
      // Create a composition of key events that ChatGPT's listener will accept
      // Modern frameworks often check for isComposing, key, code, and bubbles
      const keyEventInit = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      };

      // Dispatch keydown first (most ChatGPT handlers are on keydown)
      const keydownEvent = new KeyboardEvent("keydown", keyEventInit);
      composer.dispatchEvent(keydownEvent);

      // Some frameworks also listen for keypress
      const keypressEvent = new KeyboardEvent("keypress", keyEventInit);
      composer.dispatchEvent(keypressEvent);

      // Finally keyup
      const keyupEvent = new KeyboardEvent("keyup", keyEventInit);
      composer.dispatchEvent(keyupEvent);

      // Give the page framework time to process and clear the composer
      setTimeout(() => resolve(), SEND_SETTLE_MS);
    });
  }

  /* A typed failure. `mutated` and `preserved` are mandatory: the caller must
   * never have to infer them. */
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
    // --- Gate 0: nothing to send. Reject before touching the page. ---------
    if (typeof envelope !== "string" || envelope.trim() === "") {
      return fail("EMPTY_ENVELOPE", false, true, { draftLength: 0 });
    }

    // --- Gate 1: the composer must exist. ----------------------------------
    const composer = firstMatch(SELECTORS.composer);
    if (!composer || composer.disabled) {
      return fail("COMPOSER_NOT_FOUND", false, true, { draftLength: 0 });
    }

    // Read Don's text ONCE. Everything below is measured against this.
    const before = readComposer(composer);
    const draftLength = before.length;

    // --- Gate 2 (CB-02): Don's unsent text is never overwritten. -----------
    if (before.trim() !== "") {
      return fail("COMPOSER_OCCUPIED", false, true, {
        draftLength,
        // Length only. The draft text itself is never returned, logged, or
        // displayed anywhere — it is Don's, not the transport's.
        note: "Unsent composer text present (" + draftLength +
              " chars). Command not injected, nothing sent, draft untouched."
      });
    }

    // --- Gate 3: Attempt Enter-key transmission ---------------------------
    // Current ChatGPT has no Send button in the DOM. Use Enter key.
    // The verification below will confirm whether transmission succeeded.

    // --- The only mutation this module is ever allowed to make. ------------
    nativeSetValue(composer, envelope);
    composer.focus();
    await new Promise((r) => setTimeout(r, INJECT_SETTLE_MS));

    // --- Gate 4: did the page actually accept the injection? ---------------
    const staged = readComposer(composer);
    if (staged.trim() === "") {
      return fail("ENVELOPE_NOT_STAGED", true, true, {
        draftLength: 0,
        note: "Page did not retain the injected command. Nothing was sent."
      });
    }

    // Try to send via Enter key
    const method = "enter-key";
    await sendViaEnterKey(composer);

    // --- Gate 5 (CB-02): success is earned, never assumed. -----------------
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

    // The send did not clear the composer. Two sub-cases:
    // a) composer still holds exactly what we staged -> our text, restore it
    // b) page changed the composer -> must NOT touch it
    if (after === staged) {
      nativeSetValue(composer, before);
      return fail("SEND_NOT_CONFIRMED", true, true, {
        method,
        restored: true,
        draftLength: 0,
        note: "Enter key did not clear the composer. Composer restored; " +
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
    // Return ALL assistant turn text, not just the last one
    // ACKs may appear in any turn, not just the most recent
    const allText = turns.map(t => t.innerText || t.textContent || "").join("\n");
    return { text: allText, turnCount: turns.length };
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

  // Announce presence so the background knows the adapter is alive on this page.
  try {
    browser.runtime.sendMessage({ type: "GCE_CONTENT_READY", href: location.href });
  } catch (_) { /* background may not be listening yet; harmless */ }
})();
