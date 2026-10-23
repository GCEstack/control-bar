"use strict";

/*
 * GCE Don Control Bar — SACRIFICIAL ChatGPT transport adapter.
 *
 * RESPONSIBILITIES (spec §7) — and ONLY these:
 *   1. locate the active ChatGPT composer
 *   2. place the complete command envelope into it
 *   3. trigger send
 *   4. observe subsequent assistant output
 *   5. identify properly delimited [GCE-ACK v1] blocks
 *   6. pass matching acknowledgements to the extension shell
 *
 * IT KNOWS NOTHING about bootstrap / framework / anchor / handoff / session
 * / confidence / state inference. It has no GCE vocabulary. It is a pipe.
 *
 * If ChatGPT changes its DOM, WE REPLACE THIS MODULE. Nothing above it changes.
 *
 * The DOM strategy is selector-list based and declared in one place
 * (SELECTORS) so replacement is a single-object edit.
 */

const GCEChatGPTAdapter = (() => {
  const SELECTORS = {
    // Composer candidates, most specific first.
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
    // Send button candidates, most specific first.
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
    // Assistant turn container candidates.
    assistantTurn: [
      "[data-message-author-role='assistant']",
      "article[data-testid^='conversation-turn']",
      ".agent-turn",
      "[data-testid='conversation-turn']"
    ]
  };

  const OBSERVER_POLL_MS = 700;
  const SEND_SETTLE_MS = 250;

  function firstMatch(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function allMatches(root, selectors) {
    const out = [];
    for (const sel of selectors) {
      const found = root.querySelectorAll(sel);
      for (const el of found) out.push(el);
      if (out.length > 0) break;
    }
    return Array.from(out);
  }

  /*
   * Resolve the active ChatGPT tab. Returns { tabId, url } or null.
   * Prefers an already-focused ChatGPT tab; falls back to any ChatGPT tab.
   */
  async function resolveTargetTab() {
    const pattern = /^https:\/\/(www\.|chat\.)?chatgpt\.com\//;
    const urlMatches = (u) => typeof u === "string" && pattern.test(u);

    const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
    for (const tab of activeTabs) {
      if (urlMatches(tab.url)) return { tabId: tab.id, url: tab.url };
    }

    const allTabs = await browser.tabs.query({ currentWindow: true });
    for (const tab of allTabs) {
      if (urlMatches(tab.url)) return { tabId: tab.id, url: tab.url };
    }

    return null;
  }

  /*
   * Carry the content script's composer verdict through verbatim (CB-02).
   *
   * The content script is the only component that can see whether Don's
   * composer was touched. v1 collapsed its answer to `{ok}` and DROPPED
   * `clearedComposer`, so a command that was staged and never sent was
   * indistinguishable upstairs from one that was sent and cleared. These four
   * fields are the whole safety signal and must not be summarised away.
   */
  function composerVerdict(response, ok) {
    return {
      composerMutated: response.composerMutated === true,
      draftPreserved: response.draftPreserved !== false,
      draftLength: typeof response.draftLength === "number" ? response.draftLength : null,
      restored: response.restored === true
    };
  }

  /*
   * Serialize an async send into the target tab. We do this via a message to
   * the content script, which owns DOM interaction. The adapter itself never
   * touches page DOM — that is the content script's job. This module decides
   * WHICH tab and reports the result; the content script performs steps 1-3.
   */
  async function send({ envelope }) {
    const target = await resolveTargetTab();
    if (!target || target.tabId == null) {
      return { ok: false, error: "NO_CHATGPT_TAB", composerMutated: false, draftPreserved: true, draftLength: null };
    }

    let response;
    try {
      response = await browser.tabs.sendMessage(target.tabId, {
        type: "GCE_SEND_ENVELOPE",
        envelope
      });
    } catch (e) {
      return {
        ok: false,
        error: "CONTENT_SCRIPT_UNREACHABLE: " + String(e && e.message ? e.message : e),
        composerMutated: false,
        draftPreserved: true,
        draftLength: null
      };
    }

    if (!response) {
      return { ok: false, error: "NO_CONTENT_RESPONSE", composerMutated: false, draftPreserved: true, draftLength: null };
    }
    if (response.ok !== true) {
      return Object.assign(
        { ok: false, error: response.error || "COMPOSER_INJECT_FAILED", disposition: response.disposition },
        composerVerdict(response, false),
        { note: response.note || "" }
      );
    }

    /*
     * A content script that says ok:true MUST have proven the composer
     * cleared. Anything else is an unverified send and is reported as a
     * failure, not laundered into a success.
     */
    if (response.clearedComposer !== true) {
      return Object.assign(
        { ok: false, error: "SEND_NOT_CONFIRMED", disposition: "FAILED_NOT_SENT", method: response.method },
        composerVerdict(response, false),
        { note: "Content script did not confirm the composer cleared; send not reported as successful." }
      );
    }

    return Object.assign(
      { ok: true, tabId: target.tabId, url: target.url, method: response.method, clearedComposer: true },
      composerVerdict(response, true)
    );
  }

  async function stage(text) {
    const target = await resolveTargetTab();
    if (!target || target.tabId == null) {
      return { ok: false, error: "NO_CHATGPT_TAB" };
    }
    try {
      const response = await browser.tabs.sendMessage(target.tabId, { type: "GCE_BOOTSTRAP", text });
      if (!response) return { ok: false, error: "NO_CONTENT_RESPONSE" };
      /* DON CORRECTION (1.7.4): replacedDraftLength must survive the hop.
       * The panel uses it to tell Don his draft was overwritten instead of
       * silently dropping it. Dropping the field made staging look like it
       * did nothing. */
      return {
        ok: response.ok === true,
        error: response.error,
        note: response.note,
        replacedDraftLength: response.replacedDraftLength || 0
      };
    } catch (e) {
      return { ok: false, error: "CONTENT_SCRIPT_UNREACHABLE: " + String(e && e.message ? e.message : e) };
    }
  }

  /*
   * Ask the content script for the text of the newest assistant turn(s).
   * The content script returns RAW TEXT. ACK identification happens in the
   * protocol layer, not here.
   */
  async function observeAssistantOutput() {
    const target = await resolveTargetTab();
    if (!target || target.tabId == null) {
      return { ok: false, error: "NO_CHATGPT_TAB" };
    }
    try {
      const response = await browser.tabs.sendMessage(target.tabId, { type: "GCE_OBSERVE" });
      if (!response) return { ok: false, error: "NO_CONTENT_RESPONSE" };
      /* DON CORRECTION (1.7.5): `observed` MUST be carried across here.
       * The content script extracts seat/mode/objective from the session
       * header, and this adapter was dropping it on the floor. The panel then
       * received text with no observed field and rendered the strip as "—"
       * with "No GCE session here" while Don was plainly mid-session. This
       * single missing field is why ingestion looked broken. */
      return {
        ok: true,
        text: response.text || "",
        turnCount: response.turnCount || 0,
        observed: response.observed || null
      };
    } catch (e) {
      return { ok: false, error: "CONTENT_SCRIPT_UNREACHABLE: " + String(e && e.message ? e.message : e) };
    }
  }

  return {
    SELECTORS,
    resolveTargetTab,
    send,
    stage,
    observeAssistantOutput,
    OBSERVER_POLL_MS,
    firstMatch,
    allMatches
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = GCEChatGPTAdapter;
}
