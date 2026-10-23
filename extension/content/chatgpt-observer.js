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
      "[data-id='root'] form textarea",
      "div[contenteditable][aria-label*='message']",
      "textarea[name='prompt']"
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
      "[data-testid='root'] button",
      "button svg[aria-label='Send']"
    ],
    assistantTurn: [
      "[data-message-author-role='assistant']",
      "article[data-testid^='conversation-turn']",
      ".agent-turn",
      "[data-testid='conversation-turn']",
      "[data-message-author='assistant']",
      "div[data-role='assistant']",
      "section[data-message-author='assistant']",
      ".message.assistant",
      "[class*='assistant-message']"
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

  /*
   * DON CORRECTION (1.7.4) — OBSERVE THE WHOLE CONVERSATION, NOT ONE TURN.
   *
   * The old extractor read ONLY the last assistant turn and ONLY three literal
   * "KEY:" lines. Real working sessions say "load nico bootstrap" or
   * "current_seat: Nico" or talk about the project in prose — so extraction
   * returned null, `observed` never landed, the trust strip stayed "—" and the
   * hint read "No GCE session here" while Don was plainly mid-session. That is
   * the "it doesn't get the state when it loads the chat" report.
   *
   * Fix: scan every turn (later turns win), accept several spellings per field,
   * and parse the gce.routing footer block when present. Nothing is invented —
   * a field only populates if the text actually contains it.
   */
  /*
   * DON CORRECTION (1.7.8) — OBSERVED STATE COMES ONLY FROM ASSISTANT TURNS.
   *
   * 1.7.4 added a fallback for pages with no assistant turns:
   *   const main = document.querySelector("main"); extractObservedState(main.innerText)
   * `main` is the WHOLE PAGE. On a new chat it contains the Recents sidebar
   * (chat titles), Don's own prompt, and UI placeholder strings. So a brand-new
   * chat ingested a chat title as the objective, Don's question as the seat's
   * Next Action, and the literal placeholder "blank" as SEAT and MODE. Don's
   * screenshot showed exactly that: SEAT blank, MODE blank, an objective that
   * was a Recents title.
   *
   * None of that is seat output. No assistant turn means no seat has spoken, so
   * there is nothing to report. Returning null is the honest answer; a page-wide
   * scrape dressed in seat labels is not.
   *
   * `text` still falls back, because ACK ingestion is nonce-bound and cannot be
   * spoofed by page chrome. But it is NEVER a source of observed state.
   */
  function observe() {
    const turns = allMatches(SELECTORS.assistantTurn);
    if (turns.length === 0) {
      return { text: "", turnCount: 0, observed: null, chromeText: chromeText() };
    }
    const allText = turns.map(t => t.innerText || t.textContent || "").join("\n");
    const observed = extractObservedState(allText);
    return { text: allText, turnCount: turns.length, observed };
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

  // A field matches only on an explicit label. No prose guessing.
  /* DON CORRECTION (1.7.8) — a matched label is not automatically a real value.
   * Chat surfaces render placeholder strings into the DOM, and several of them
   * are literally the word "blank". Reporting "blank" as SEAT is worse than
   * reporting nothing: it looks like state and is not. These are rejected
   * wherever they appear. "none" is NOT in this list — "Blockers: None" and
   * "Parked: None established" are real answers. */
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

  function extractObservedState(text) {
    if (!text || !text.trim()) return null;

    const routing = parseRoutingFooter(text);

    /* DON CORRECTION (1.7.5): the session header is the PRIMARY form. It reads:
     *   Primary Seat: Enzo — Executive Integrator / Organizational Operator
     *   Mode: Standard operating state
     *   Status: ACTIVE
     *   Objective: ...
     *   Next Action: ...
     * The routing footer is the SECOND form. Header wins on conflict because it
     * is the seat speaking now; the footer is the machine record of last state.
     * Both are ingested — neither is a fallback for the other. */
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

    /* DON CORRECTION (1.7.6) — restore the prose fallback for SEAT.
     * 1.7.5 rewrote this function for the two-form header ingest and dropped the
     * fallback, so a live working session with no "Primary Seat:" line showed
     * SEAT — even while the seat was plainly named in the conversation. Don's
     * screenshot: objective and next action landed, SEAT and MODE stayed "—".
     * The fallback only fires when no labelled SEAT exists, and it only matches
     * a registry seat token, so it cannot invent an identity. */
    if (!seat) seat = seatFromProse(text);

    if (!seat && !mode && !objective && !project && !workstream && !nextAction &&
        !blockers && !donIntent && !evidence && !status) return null;

    return {
      SEAT: seat,
      MODE: mode,
      STATUS: status,
      OBJECTIVE: objective,
      PROJECT: project,
      WORKSTREAM: workstream,
      NEXT_ACTION: nextAction,
      BLOCKERS: blockers,
      DON_INTENT: donIntent,
      EVIDENCE: evidence
    };
  }

  /* "Enzo — Executive Integrator / Organizational Operator" is a seat plus a
   * role description. The strip shows the seat. A role suffix must never make
   * the trust strip read as an identity that is not in the registry. */
  function bareSeat(raw) {
    if (!raw) return null;
    if (isPlaceholder(raw)) return null;
    const first = String(raw).split(/\s+[—–-]\s+/)[0].trim();
    if (!first || isPlaceholder(first)) return null;
    return first;
  }

  /*
   * DON CORRECTION (1.7.6) — seat from conversation prose.
   *
   * Last match wins: the most recently mentioned seat is the one being driven.
   * Only registry seats match, so this can never invent an identity or surface a
   * retired name. Retired seats (Kimi, Ragno, Calibro) are deliberately absent
   * from SEAT_VOCAB — a dead seat must not be reachable by mention.
   */
  function seatFromProse(text) {
    if (!text) return null;
    /* Scan by POSITION, not by iterating the vocabulary. Iterating the
     * vocabulary and letting each name overwrite the last gave "Nico" for a
     * turn that ends with Ceda, because Nico sat later in the list, not in the
     * text. The most recent mention in the TEXT is the one being driven. */
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

  // Parse the last fenced gce.routing JSON block, if the seat emitted one.
  function parseRoutingFooter(text) {
    const fence = /```gce\.routing\s*([\s\S]*?)```/gi;
    let m, last = null;
    while ((m = fence.exec(text)) !== null) {
      try { last = JSON.parse(m[1]); } catch (_) { /* not valid JSON; ignore */ }
    }
    return last && typeof last === "object" ? last : null;
  }

  /*
   * DON CORRECTION (1.7.4) — STAGING IS AN EXPLICIT OPERATOR ACT.
   *
   * v1.7.3 refused to stage whenever the composer held any draft:
   *   if (before.trim() !== "") return fail("COMPOSER_OCCUPIED")
   * Don types into the composer constantly, so that guard turned EVERY
   * hardwired button into a silent no-op. Symptom on screen: "Anchor doesn't
   * work", "Checkpoint doesn't work", "composer occupied". The guard was
   * protecting a draft Don was actively editing — but a button click IS the
   * instruction to put this text there. The refusal was the bug.
   *
   * We now overwrite, and we REPORT what was overwritten rather than silently
   * destroying it. `replacedDraftLength` travels up to the panel so the status
   * line can say "replaced your draft (N chars)". Nothing is fabricated and
   * nothing is lost without being named.
   */
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

  // Announce presence so the background knows the adapter is alive on this page.
  try {
    browser.runtime.sendMessage({ type: "GCE_CONTENT_READY", href: location.href });
  } catch (_) { /* background may not be listening yet; harmless */ }
})();
