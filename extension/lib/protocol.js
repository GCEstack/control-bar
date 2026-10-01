"use strict";

/*
 * GCE Don Control Bar — protocol layer.
 *
 * ZERO GCE COMMAND SEMANTICS LIVE HERE.
 * This module builds the [GCE-CMD v1] envelope byte-for-byte and parses
 * [GCE-ACK v1] blocks. It does not know what Bootstrap, Re-Center, Frame,
 * Anchor, Handoff, or End mean. It does not interpret governance.
 *
 * The control IDs and their RETURN_STATE defaults are the frozen spec table
 * (§4, §6). Those are transport defaults, not semantics.
 */

const GCEProtocol = (() => {
  const CMD_VERSION = "GCE-CMD v1";
  const CMD_CLOSE = "[/GCE-CMD]";
  // Frozen spec §8: open tag is [GCE-ACK v1], close tag is [/GCE-ACK]
  // (the version appears only on the open tag). Match the spec exactly.
  const ACK_VERSION = "GCE-ACK v1";
  const ACK_OPEN = "[" + ACK_VERSION + "]";
  const ACK_CLOSE = "[/GCE-ACK]";
  const FRAME_CURRENT = "CURRENT";

  // Frozen spec §4 control surface. order is display order.
  const CONTROLS = [
    { id: "RELOAD_BOOTSTRAP", label: "Bootstrap", key: "cmd-reload-bootstrap" },
    { id: "RECENTER_SESSION", label: "Re-Center", key: "cmd-recenter-session" },
    { id: "REASSERT_FRAME", label: "Frame", key: "cmd-reassert-frame" },
    { id: "SHOW_STATE", label: "State", key: "cmd-show-state" },
    { id: "ANCHOR_COMMIT", label: "Anchor", key: "cmd-anchor-commit" },
    { id: "CREATE_HANDOFF", label: "Handoff", key: "cmd-create-handoff" },
    { id: "END_SESSION", label: "End", key: "cmd-end-session" }
  ];

  // Frozen spec §6 RETURN_STATE defaults.
  const RETURN_STATE_DEFAULTS = {
    RELOAD_BOOTSTRAP: false,
    RECENTER_SESSION: true,
    REASSERT_FRAME: false,
    SHOW_STATE: true,
    ANCHOR_COMMIT: true,
    CREATE_HANDOFF: true,
    END_SESSION: true
  };

  const VALID_RESULTS = new Set([
    "ACCEPTED",
    "REJECTED",
    "PARTIAL",
    "UNKNOWN_COMMAND",
    "VERSION_MISMATCH",
    "AMBIGUOUS_STATE"
  ]);

  // Frozen spec §9 — the ONLY displayable state fields, in display order.
  const STATE_FIELDS = [
    "AUTHORITY",
    "SEAT",
    "MODE",
    "DON_INTENT",
    "OBJECTIVE",
    "CURRENT_TASK",
    "MATURITY",
    "STATUS",
    "CONFIDENCE",
    "BLOCKERS",
    "LAST_ANCHOR",
    "NEXT_ACTION"
  ];

  // Compact header field per spec §9 desired presentation.
  const STATE_HEADER_FIELDS = ["SEAT", "STATUS", "LAST_ANCHOR"];

  const CONTROL_IDS = new Set(CONTROLS.map((c) => c.id));

  function controlById(id) {
    return CONTROLS.find((c) => c.id === id) || null;
  }

  function controlByCommandName(name) {
    return CONTROLS.find((c) => c.key === name) || null;
  }

  function isKnownControl(id) {
    return CONTROL_IDS.has(id);
  }

  function defaultReturnState(id) {
    if (!Object.prototype.hasOwnProperty.call(RETURN_STATE_DEFAULTS, id)) return false;
    return RETURN_STATE_DEFAULTS[id];
  }

  /*
   * NONCE: GCE-<epoch-ms>-<sequence>
   * sequence is monotonic per browser session and never reused.
   */
  function makeNonce(epochMs, sequence) {
    return "GCE-" + epochMs + "-" + sequence;
  }

  function parseNonce(nonce) {
    if (typeof nonce !== "string") return null;
    const m = /^GCE-(\d+)-(\d+)$/.exec(nonce.trim());
    if (!m) return null;
    return { epochMs: Number(m[1]), sequence: Number(m[2]), raw: nonce.trim() };
  }

  /*
   * Build the complete command envelope.
   * The envelope is the ENTIRE user message (spec §5). No prose, no wrapper.
   */
  function buildCommandEnvelope({ commandId, seat, nonce, frame, returnState }) {
    const cmd = String(commandId || "").trim();
    const st = String(seat || "").trim().toUpperCase();
    const nn = String(nonce || "").trim();
    const fr = String(frame || FRAME_CURRENT).trim().toUpperCase();
    const rs = returnState === true ? "TRUE" : "FALSE";

    if (!CONTROL_IDS.has(cmd)) {
      throw new Error("UNKNOWN CONTROL ID: " + cmd);
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(st)) {
      throw new Error("INVALID SEAT TOKEN: " + seat);
    }
    if (!parseNonce(nn)) {
      throw new Error("INVALID NONCE: " + nonce);
    }
    if (fr !== FRAME_CURRENT) {
      throw new Error("INVALID FRAME: " + frame);
    }

    return (
      "[" + CMD_VERSION + "]\n" +
      "CMD: " + cmd + "\n" +
      "SEAT: " + st + "\n" +
      "NONCE: " + nn + "\n" +
      "FRAME: " + fr + "\n" +
      "RETURN_STATE: " + rs + "\n" +
      CMD_CLOSE
    );
  }

  /*
   * Extract every properly delimited [GCE-ACK v1] ... [/GCE-ACK] block.
   * Deliberately strict on delimiters: a block must start at a line that is
   * exactly the open tag and end at a line that is exactly the close tag.
   * Anything else is not a protocol frame.
   */
  function extractAckBlocks(text) {
    if (typeof text !== "string" || text.length === 0) return [];
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let current = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (current === null) {
        if (line === ACK_OPEN) current = [];
        continue;
      }
      if (line === ACK_CLOSE) {
        blocks.push(current.join("\n"));
        current = null;
        continue;
      }
      current.push(rawLine);
    }
    // Unterminated block is discarded. No partial ACK is ever accepted.
    return blocks;
  }

  function parseFieldLine(line) {
    const idx = line.indexOf(":");
    if (idx < 0) return null;
    const key = line.slice(0, idx).trim().toUpperCase();
    const value = line.slice(idx + 1).trim();
    if (!key) return null;
    return { key, value };
  }

  /*
   * Parse one ACK block body into a structured record.
   * RESULT must be one of the frozen result tokens. A missing or unknown
   * RESULT yields result "UNKNOWN_COMMAND" ONLY if RESULT is literally absent;
   * otherwise it is a malformed ACK and is rejected outright.
   */
  function parseAckBlock(body) {
    const rawLines = body.split(/\r?\n/);
    const fields = Object.create(null);
    const stateLines = [];
    let inState = false;

    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line === "STATE:") { inState = true; continue; }

      if (inState) {
        stateLines.push(line);
        continue;
      }

      const parsed = parseFieldLine(line);
      if (!parsed) continue;

      if (parsed.key === "STATE") {
        inState = true;
        if (parsed.value) stateLines.push(parsed.value);
        continue;
      }
      fields[parsed.key] = parsed.value;
    }

    if (!("RESULT" in fields)) {
      return { ok: false, reason: "ACK_MISSING_RESULT" };
    }
    const result = fields.RESULT.toUpperCase();
    if (!VALID_RESULTS.has(result)) {
      return { ok: false, reason: "ACK_INVALID_RESULT:" + result };
    }
    if (!("CMD" in fields) || !fields.CMD) {
      return { ok: false, reason: "ACK_MISSING_CMD" };
    }
    if (!("NONCE" in fields) || !parseNonce(fields.NONCE)) {
      return { ok: false, reason: "ACK_MISSING_OR_INVALID_NONCE" };
    }

    const state = parseStateBlock(stateLines);

    return {
      ok: true,
      ack: {
        version: ACK_VERSION,
        cmd: fields.CMD,
        nonce: fields.NONCE,
        result,
        note: fields.NOTE !== undefined ? fields.NOTE : "",
        stateRequested: Object.prototype.hasOwnProperty.call(fields, "STATE"),
        state
      }
    };
  }

  /*
   * Parse the STATE block into ONLY the frozen display fields (spec §9).
   * Unknown keys are dropped. Values are never computed here.
   */
  function parseStateBlock(lines) {
    const out = Object.create(null);
    for (const line of lines) {
      const parsed = parseFieldLine(line);
      if (!parsed) continue;
      if (STATE_FIELDS.includes(parsed.key)) {
        out[parsed.key] = parsed.value;
      }
    }
    return out;
  }

  function parseAllAcks(text) {
    const acks = [];
    const rejected = [];
    for (const block of extractAckBlocks(text)) {
      const parsed = parseAckBlock(block);
      if (parsed.ok) acks.push(parsed.ack);
      else rejected.push({ reason: parsed.reason, block });
    }
    return { acks, rejected };
  }

  return {
    CMD_VERSION,
    CMD_CLOSE,
    ACK_VERSION,
    ACK_OPEN,
    ACK_CLOSE,
    FRAME_CURRENT,
    CONTROLS,
    CONTROL_IDS,
    RETURN_STATE_DEFAULTS,
    VALID_RESULTS,
    STATE_FIELDS,
    STATE_HEADER_FIELDS,
    controlById,
    controlByCommandName,
    isKnownControl,
    defaultReturnState,
    makeNonce,
    parseNonce,
    buildCommandEnvelope,
    extractAckBlocks,
    parseAckBlock,
    parseAllAcks
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = GCEProtocol;
}
