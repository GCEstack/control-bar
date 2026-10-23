"use strict";

/*
 * GCE Don Control Bar — SACRIFICIAL Kimi transport adapter.
 *
 * RESPONSIBILITIES (spec §7) — and ONLY these:
 *   1. locate the active Kimi composer
 *   2. place the complete command envelope into it
 *   3. trigger send
 *   4. observe subsequent assistant output
 *   5. identify properly delimited [GCE-ACK v1] blocks
 *   6. pass matching acknowledgements to the extension shell
 *
 * IT KNOWS NOTHING about bootstrap / framework / anchor / handoff / session
 * / confidence / state inference. It has no GCE vocabulary. It is a pipe.
 *
 * If Kimi changes its DOM, WE REPLACE THIS MODULE. Nothing above it changes.
 *
 * The DOM strategy is selector-list based and declared in one place
 * (SELECTORS) so replacement is a single-object edit.
 */

const GCEKimiAdapter = (() => {
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

  async function resolveTargetTab() {
    const pattern = /^https:\/\/(www\.|kimi\.)?kimi\.com\//;
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

  function composerVerdict(response, ok) {
    return {
      composerMutated: response.composerMutated === true,
      draftPreserved: response.draftPreserved !== false,
      draftLength: typeof response.draftLength === "number" ? response.draftLength : null,
      restored: response.restored === true
    };
  }

  async function send({ envelope }) {
    const target = await resolveTargetTab();
    if (!target || target.tabId == null) {
      return { ok: false, error: "NO_KIMI_TAB", composerMutated: false, draftPreserved: true, draftLength: null };
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
      return { ok: false, error: "NO_KIMI_TAB" };
    }
    try {
const response = await browser.tabs.sendMessage(target.tabId, { type: "GCE_BOOTSTRAP", text });
    if (!response) return { ok: false, error: "NO_CONTENT_RESPONSE" };
    /* DON CORRECTION (1.7.4): carry replacedDraftLength through, as chatgpt-adapter does. */
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

  async function observeAssistantOutput() {
    const target = await resolveTargetTab();
    if (!target || target.tabId == null) {
      return { ok: false, error: "NO_KIMI_TAB" };
    }
    try {
const response = await browser.tabs.sendMessage(target.tabId, { type: "GCE_OBSERVE" });
    if (!response) return { ok: false, error: "NO_CONTENT_RESPONSE" };
    /* DON CORRECTION (1.7.5): carry `observed` through, as chatgpt-adapter does. */
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
  module.exports = GCEKimiAdapter;
}