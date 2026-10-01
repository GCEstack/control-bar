"use strict";

/*
 * GCE Don Control Bar — sidebar shell.
 *
 * DISPLAY ONLY. This file:
 *   - renders seven buttons
 *   - renders the last seat-authored state verbatim
 *   - renders lifecycle state and staleness
 *
 * This file does NOT parse prose, does NOT infer state, does NOT calculate
 * confidence, and does NOT decide what an ACK meant. It renders strings that
 * the background already validated against a locally issued nonce.
 */

const DEFAULT_SEAT = "CODA";

const el = {
  seat: document.getElementById("hdr-seat"),
  state: document.getElementById("hdr-state"),
  statusLine: document.getElementById("status-line"),
  stale: document.getElementById("stale"),
  controls: document.getElementById("controls"),
  lastcmd: document.getElementById("lastcmd"),
  btnLog: document.getElementById("btn-log"),
  btnResume: document.getElementById("btn-resume"),
  logdlg: document.getElementById("logdlg"),
  logbody: document.getElementById("logbody"),
  btnLogClose: document.getElementById("btn-log-close")
};

let currentSnapshot = null;

function fmtAge(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

function buildControls(snapshot) {
  el.controls.textContent = "";
  for (const c of snapshot.controls) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.cmd = c.id;
    btn.dataset.label = c.label;

    const label = document.createElement("span");
    label.textContent = c.label;
    btn.appendChild(label);

    const rs = document.createElement("span");
    rs.className = "rs";
    rs.textContent = c.id + " · STATE:" + (c.returnState ? "TRUE" : "FALSE");
    btn.appendChild(rs);

    btn.addEventListener("click", () => issue(c.id));
    el.controls.appendChild(btn);
  }
}

function setLocked(locked, why) {
  for (const btn of el.controls.querySelectorAll("button")) {
    btn.disabled = locked;
  }
  el.btnResume.style.display = locked ? "" : "none";
  if (locked && why) el.lastcmd.textContent = why;
}

async function issue(commandId) {
  el.lastcmd.textContent = "SENDING " + commandId + "…";
  try {
    const r = await browser.runtime.sendMessage({ type: "GCE_ISSUE", commandId, seat: DEFAULT_SEAT });
    if (r && r.ok === false) {
      el.lastcmd.textContent = "FAILED — " + (r.topState || "ERROR") +
        (r.reason ? " (" + r.reason + ")" : "");
    }
  } catch (e) {
    el.lastcmd.textContent = "FAILED — NOT SENT (background unreachable: " + String(e && e.message ? e.message : e) + ")";
  }
}

function renderStatus(snapshot) {
  const st = snapshot.lastState;
  if (!st) {
    el.statusLine.textContent = "NO STATE RECEIVED";
    el.stale.textContent = "";
    return;
  }
  // Seat-authored values only. Nothing is computed here.
  const s = st.state || {};
  const seat = s.SEAT || "?";
  const status = s.STATUS || "?";
  const conf = s.CONFIDENCE !== undefined ? s.CONFIDENCE + "%" : "—";
  const anchor = s.LAST_ANCHOR || "—";

  el.statusLine.textContent = seat + " · " + status + "\nCONFIDENCE " + conf + "\nANCHOR: " + anchor;
  el.stale.textContent = "STATE AGE: " + fmtAge(snapshot.stateAgeMs) + "  (from " + st.commandId + ")";
}

function renderLatest(snapshot) {
  const l = snapshot.latest;
  if (!l) return;
  const parts = [l.status, l.commandId, l.nonce];
  if (l.note) parts.push("· " + l.note);
  el.lastcmd.textContent = parts.join("\n");
}

/*
 * CB-02 display. A send failure is only actionable if Don can see WHICH
 * failure it was and whether his unsent text survived. The strings come from
 * the background, which recorded them from the transport. Nothing is inferred
 * or recomputed here.
 */
function renderSendFailure(snapshot) {
  const l = snapshot.latest;
  const lines = ["FAILED — NOT SENT", "The command was not transmitted."];
  if (l && l.reason) lines.push("REASON: " + l.reason);
  if (l) {
    lines.push("DON'S UNSENT TEXT: " + (l.draftPreserved === false ? "NOT PRESERVED" : "PRESERVED"));
  }
  el.lastcmd.textContent = lines.join("\n");
}

function render(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.controls)) {
    // Never render a partial shell: a missing/malformed snapshot means the
    // background did not answer. Surface it instead of showing static HTML
    // that looks healthy while carrying zero command controls.
    el.lastcmd.textContent =
      "BACKGROUND DID NOT ANSWER — no snapshot. Command controls unavailable.\n" +
      "Reload the extension from about:debugging and check the background console.";
    el.state.textContent = "NO SNAPSHOT";
    el.state.dataset.s = "FAILED_NOT_SENT";
    return;
  }

  currentSnapshot = snapshot;
  el.seat.textContent = DEFAULT_SEAT;
  el.state.textContent = snapshot.topState;
  el.state.dataset.s = snapshot.topState;

  renderStatus(snapshot);

  if (!el.controls.childElementCount) buildControls(snapshot);

  const closed = snapshot.session && snapshot.session.closed;
  setLocked(!!closed, closed ? "NO ACTIVE SEAT — session closed. Commands reject until a new session." : null);

  if (snapshot.topState === "PENDING" && snapshot.latest) renderLatest(snapshot);
  if (snapshot.topState === "FAILED_NOT_SENT" || snapshot.topState === "FAILED_SENT_UNCONFIRMED") {
    renderSendFailure(snapshot);
  }
  if (snapshot.topState === "NO_ACTIVE_SEAT" && !closed) {
    el.lastcmd.textContent = "NO ACTIVE SEAT";
  }

  el.btnResume.style.display = closed ? "" : "none";
}

async function showLog() {
  const r = await browser.runtime.sendMessage({ type: "GCE_GET_LOG" });
  const lines = [];
  lines.push("== COMMAND LOG (outbound, append-only) ==");
  for (const e of (r.commandLog || [])) {
    lines.push("  " + (e.status || "?").padEnd(22) + " " + (e.commandId || "").padEnd(18) + " " + (e.nonce || ""));
  }
  lines.push("");
  lines.push("== ACK LOG (nonce-bound only) ==");
  for (const e of (r.ackLog || [])) {
    lines.push("  " + ("r-" + e.result).padEnd(22) + " " + String(e.cmd || "").padEnd(18) + " " + (e.nonce || ""));
  }
  lines.push("");
  lines.push("== DISCARDED PROTOCOL INPUT (never mutated state) ==");
  const rej = r.rejectedAcks || [];
  if (rej.length === 0) lines.push("  (none)");
  for (const e of rej) {
    lines.push("  " + String(e.reason || "").padEnd(22) + " " + (e.nonce || e.block || ""));
  }
  el.logbody.textContent = lines.join("\n");
  el.logdlg.showModal();
}

el.btnLog.addEventListener("click", showLog);
el.btnLogClose.addEventListener("click", () => el.logdlg.close());
el.btnResume.addEventListener("click", async () => {
  const s = await browser.runtime.sendMessage({ type: "GCE_OPEN_SESSION" });
  render(s);
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "GCE_SNAPSHOT") render(msg.snapshot);
  return undefined;
});

(async () => {
  try {
    const snap = await browser.runtime.sendMessage({ type: "GCE_GET_SNAPSHOT" });
    render(snap);
  } catch (e) {
    render(null);
    return;
  }
  setInterval(async () => {
    try {
      const s = await browser.runtime.sendMessage({ type: "GCE_GET_SNAPSHOT" });
      render(s);
    } catch (e) {
      render(null);
    }
  }, 1000);
})();
