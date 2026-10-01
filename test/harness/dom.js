"use strict";

/*
 * GCE Don Control Bar — minimal fake DOM for the CONTENT SCRIPT seam.
 *
 * WHY THIS EXISTS: the content script is the only module that touches the
 * ChatGPT composer, and it is the module that carries the CB-02 draft
 * destruction defect. It is a classic script with no module export, so the
 * acceptance harness (CommonJS) can never load it. This harness loads the
 * SHIPPED FILE UNMODIFIED into a vm context — the same technique as
 * browser-wiring-probe.js — and hands it a DOM that implements exactly the
 * surface the file uses.
 *
 * This harness implements NO GCE vocabulary and NO command semantics. It is a
 * DOM. Selectors resolve through a literal map keyed by the SHIPPED selector
 * strings, so if the shipped SELECTORS list changes, the map misses and the
 * probe FAILS LOUD rather than silently passing against a stub.
 *
 * VALUE STORAGE IS NOT FAKED. The shipped nativeSetValue reaches for
 * `window.HTMLTextAreaElement.prototype`'s real `value` setter. The fakes
 * therefore carry a descriptor-backed accessor on the PROTOTYPE and hold no
 * own `value` data property — an own property would shadow the accessor and
 * silently turn the measurement into fiction.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT_ROOT = path.join(__dirname, "..", "..", "extension");

/* The shipped composer / send / assistant selectors, kept here as a CONTRACT
 * KEY SET only. If the shipped lists gain or lose a member, querySelector
 * resolves to null for it and the probe FAILS LOUD. */
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "div[contenteditable='true'][id='prompt-textarea']",
  "textarea[data-testid='prompt-textarea']",
  "form textarea",
  "div[contenteditable='true'][role='textbox']"
];
const SEND_BUTTON_SELECTORS = [
  "button[data-testid='send-button']",
  "button[aria-label='Send message']",
  "form button[type='submit']",
  "button[aria-label='Send prompt']"
];
const ASSISTANT_SELECTORS = [
  "[data-message-author-role='assistant']",
  "article[data-testid^='conversation-turn']",
  ".agent-turn"
];

const valueStore = new WeakMap();

/* Both storage paths are cleared, so "did it actually clear?" is measured
 * against exactly the surface the shipped code reads. */
function clearComposerText(el) {
  if (!el) return;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") el.value = "";
  el.textContent = "";
  el.innerText = "";
}

class FakeTextArea {
  get value() { return valueStore.has(this) ? valueStore.get(this) : ""; }
  set value(v) { valueStore.set(this, String(v)); }
}
class FakeInput {
  get value() { return valueStore.has(this) ? valueStore.get(this) : ""; }
  set value(v) { valueStore.set(this, String(v)); }
}

class FakeElement {
  constructor(kind, opts) {
    this.kind = kind; // "composer" | "send" | "assistant"
    this.tagName = (opts.tagName || "DIV").toUpperCase();
    this.disabled = opts.disabled === true;
    this.attributes = Object.assign({}, opts.attributes || {});
    this.events = [];
    this.focused = 0;
    this.clicks = 0;
    this.clearsOnClick = opts.clearsOnClick !== false;
    this.textContent = opts.textContent !== undefined ? opts.textContent : "";
    this.innerText = this.textContent;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  focus() { this.focused += 1; }

  click() {
    this.clicks += 1;
    // The SEND BUTTON does not clear itself: the PAGE clears the composer when
    // the message is accepted. Modelling that on the button is what makes
    // "did it really clear?" an honest measurement rather than a tautology.
    if (this.clearsOnClick && this.composerRef) clearComposerText(this.composerRef);
  }

  dispatchEvent(ev) {
    this.events.push(ev && ev.type ? ev.type : String(ev));
    return true;
  }

  querySelector() { return null; }
  querySelectorAll() { return []; }
}

class FakeComposerTextarea extends FakeElement {
  constructor(opts) { super("composer", Object.assign({ tagName: "TEXTAREA" }, opts)); }
  // Same WeakMap store as FakeTextArea.prototype, so the descriptor the shipped
  // code pulls off `window.HTMLTextAreaElement.prototype` and the descriptor the
  // element actually has are two views of ONE storage slot.
  get value() { return valueStore.has(this) ? valueStore.get(this) : ""; }
  set value(v) { valueStore.set(this, String(v)); }
}

class FakeComposerEditable extends FakeElement {
  constructor(opts) { super("composer", Object.assign({ tagName: "DIV" }, opts)); }
}

/*
 * makeComposer — the element the shipped SELECTORS.composer list resolves to.
 * kind: "textarea"        -> the shipped nativeSetValue value-setter path
 *       "contenteditable" -> the shipped textContent + InputEvent path
 */
function makeComposer(kind, opts) {
  opts = Object.assign({}, opts || {});
  const text = opts.text !== undefined ? opts.text : "";
  if (kind === "textarea") {
    const el = new FakeComposerTextarea(opts);
    el.value = text;
    return el;
  }
  return new FakeComposerEditable(Object.assign({}, opts, { textContent: text }));
}

/*
 * makeSendButton — `opts.composer` is the composer the PAGE will clear if the
 * send is accepted. Without it the send control is modelled as a no-op, which
 * is how a broken/disabled send path looks from the transport's side.
 */
function makeSendButton(opts) {
  opts = Object.assign({}, opts || {});
  const btn = new FakeElement("send", Object.assign({ tagName: "BUTTON" }, opts));
  btn.composerRef = opts.composer || null;
  return btn;
}

// Module-level prototype wiring. It MUST happen at load time, not per
// loadObserver() call: the probe constructs elements BEFORE it loads the
// script, and a chain re-linked afterwards would leave those elements with an
// own `value` data property shadowing the accessor the shipped code writes to.
Object.setPrototypeOf(FakeTextArea.prototype, Object.create(FakeElement.prototype));
Object.setPrototypeOf(FakeInput.prototype, Object.create(FakeElement.prototype));
FakeTextArea.prototype.constructor = FakeTextArea;
FakeInput.prototype.constructor = FakeInput;

/*
 * loadObserver — evaluate the SHIPPED content script in a fresh vm context and
 * return { send, ping, ... }. `send` invokes the script's own runtime message
 * listener with a GCE_SEND_ENVELOPE, so every assertion is made against shipped
 * code, never against a re-implementation.
 */
async function loadObserver(page) {
  const listeners = [];
  const sentMessages = [];

  const doc = {
    querySelector(sel) {
      if (COMPOSER_SELECTORS.includes(sel)) return page.composer || null;
      if (SEND_BUTTON_SELECTORS.includes(sel)) return page.sendButton || null;
      if (ASSISTANT_SELECTORS.includes(sel)) return page.assistantTurn || null;
      if (sel === "main") return page.main || null;
      if (sel === "body") return page.body || null;
      return null;
    },
    querySelectorAll(sel) {
      if (ASSISTANT_SELECTORS.includes(sel)) return page.assistantTurn ? [page.assistantTurn] : [];
      return [];
    }
  };

  class FakeEvent {
    constructor(type) { this.type = type; }
  }
  class FakeInputEvent extends FakeEvent {
    constructor(type, init) { super(type); Object.assign(this, init || {}); }
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    document: doc,
    location: { href: page.href || "https://chatgpt.com/c/abc" },
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    KeyboardEvent: FakeEvent,
    browser: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: async (m) => { sentMessages.push(m); return undefined; }
      }
    }
  };

  // The shipped code resolves these through `window.<Ctor>.prototype`. The fakes
  // must be the SAME objects the elements inherit from, or the setter the
  // shipped code calls is not the setter the element has.
  sandbox.HTMLTextAreaElement = FakeTextArea;
  sandbox.HTMLInputElement = FakeInput;
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  const file = path.join(EXT_ROOT, "content", "chatgpt-observer.js");
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, ctx, { filename: "extension/content/chatgpt-observer.js" });

  if (listeners.length !== 1) {
    throw new Error("content script registered " + listeners.length + " runtime listeners (expected 1)");
  }

  async function send(envelope) {
    const reply = await listeners[0]({ type: "GCE_SEND_ENVELOPE", envelope });
    return Object.assign({ type: "GCE_SEND_ENVELOPE_RESULT" }, reply);
  }
  async function ping() {
    return listeners[0]({ type: "GCE_PING" });
  }

  return { send, ping, listeners, sentMessages, sandbox };
}

module.exports = {
  loadObserver,
  makeComposer,
  makeSendButton,
  FakeElement,
  COMPOSER_SELECTORS,
  SEND_BUTTON_SELECTORS
};
