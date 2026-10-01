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
  // VERNACULAR ROW (L1) - Don's primary interaction layer
  const VERNACULAR_CONTROLS = [
    { id: "CAPISCE", label: "CAPISCE", key: "cmd-capisce", isVernacular: true },
    { id: "HOLD", label: "HOLD", key: "cmd-hold", isVernacular: true, supportsLatch: true },
    { id: "BRANCH", label: "BRANCH", key: "cmd-branch", isVernacular: true },
    { id: "RECENTER_SESSION", label: "RE-CENTER", key: "cmd-recenter-session", isVernacular: true },
    { id: "PARK", label: "PARK", key: "cmd-park", isVernacular: true }
  ];

  // SESSION TOOLS - maintenance controls in drawer
  const SESSION_TOOLS = [
    { id: "RELOAD_BOOTSTRAP", label: "Bootstrap", key: "cmd-reload-bootstrap" },
    { id: "REASSERT_FRAME", label: "Frame", key: "cmd-reassert-frame" },
    { id: "SHOW_STATE", label: "State", key: "cmd-show-state" },
    { id: "ANCHOR_COMMIT", label: "Checkpoint", key: "cmd-anchor-commit" },
    { id: "CREATE_HANDOFF", label: "Handoff", key: "cmd-create-handoff" },
    { id: "PROMOTE", label: "Promote", key: "cmd-promote" },
    { id: "SUPERSEDE", label: "Supersede", key: "cmd-supersede" },
    { id: "END_SESSION", label: "End Session", key: "cmd-end-session" },
    { id: "RELEASE_HOLD", label: "Release Hold", key: "cmd-release-hold" },
    { id: "RESUME_PARKED", label: "Resume Parked", key: "cmd-resume-parked" }
  ];

  const CONTROLS = [...VERNACULAR_CONTROLS, ...SESSION_TOOLS];

  // Frozen spec §6 RETURN_STATE defaults.
  const RETURN_STATE_DEFAULTS = {
    CAPISCE: true,
    HOLD: true,
    RELEASE_HOLD: true,
    BRANCH: true,
    RECENTER_SESSION: true,
    PARK: true,
    RESUME_PARKED: true,
    RELOAD_BOOTSTRAP: false,
    REASSERT_FRAME: false,
    SHOW_STATE: true,
    ANCHOR_COMMIT: true,
    CREATE_HANDOFF: true,
    PROMOTE: true,
    SUPERSEDE: true,
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
  // Full state snapshot from §3 + legacy field names for backward compatibility
  const STATE_FIELDS = [
    "AUTHORITY",
    "PRIMARY_SEAT",
    "SEAT",
    "MODE",
    "SESSION_ID",
    "SESSION_STATUS",
    "STATUS",
    "DON_INTENT",
    "OBJECTIVE",
    "CURRENT_TASK",
    "PROJECT",
    "WORKSTREAM",
    "CURRENT_BRANCH",
    "ORIGINATING_ANCHOR",
    "CURRENT_ANCHOR",
    "LAST_ANCHOR",
    "PROMOTED_CURRENT",
    "PARKED",
    "PARKED_ITEMS",
    "CHECKPOINT",
    "NEXT_ROUTE",
    "BLOCKER_ROUTE",
    "BLOCKERS",
    "HANDOFF_STATE",
    "NEXT_ACTION",
    "CONFIDENCE",
    "MATURITY",
    "STATE_FRESHNESS",
    "STATE_AS_OF"
  ];

  // Compact header field per spec §9 desired presentation.
  const STATE_HEADER_FIELDS = ["PRIMARY_SEAT", "MODE", "STATE_FRESHNESS", "CURRENT_BRANCH"];

  // Freshness states per §3
  const FRESHNESS_STATES = new Set(["CURRENT", "STALE", "UNKNOWN"]);

  const CONTROL_IDS = new Set(CONTROLS.map((c) => c.id));

  const PAYLOAD_ALLOWLIST = new Set(["BRANCH", "PARK", "RESUME_PARKED", "PROMOTE", "SUPERSEDE", "ANCHOR_COMMIT"]);
  const MAX_PAYLOAD_SIZE = 8192;
  const PAYLOAD_SCHEMAS = {
    BRANCH: { required: ["branchName"], optional: ["origin"] },
    PARK: { optional: ["currentReference", "parkReason"] },
    RESUME_PARKED: { required: ["parkedIdentity"], optional: [] },
    PROMOTE: { required: ["target"], optional: ["replacesCurrent"] },
    SUPERSEDE: { required: ["supersedeTarget"], optional: ["provenance"] },
    ANCHOR_COMMIT: { optional: ["checkpointLabel", "description"] }
  };

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

  function validatePayload(commandId, payload) {
    if (!payload || typeof payload !== "object") return { valid: false, reason: "PAYLOAD_MUST_BE_OBJECT" };
    if (!PAYLOAD_ALLOWLIST.has(commandId)) {
      if (Object.keys(payload).length > 0) {
        return { valid: false, reason: "PAYLOAD_NOT_ALLOWED_FOR_" + commandId };
      }
      return { valid: true };
    }
    const schema = PAYLOAD_SCHEMAS[commandId];
    const payloadStr = JSON.stringify(payload);
    if (payloadStr.length > MAX_PAYLOAD_SIZE) {
      return { valid: false, reason: "PAYLOAD_SIZE_EXCEEDED" };
    }
    for (const req of schema.required) {
      if (!(req in payload)) {
        return { valid: false, reason: "PAYLOAD_MISSING_REQUIRED_" + req };
      }
    }
    const allowed = new Set([...schema.required, ...schema.optional]);
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) {
        return { valid: false, reason: "PAYLOAD_UNEXPECTED_KEY_" + key };
      }
    }
    return { valid: true };
  }

  /*
   * Build the complete command envelope.
   * The envelope is the ENTIRE user message (spec §5). No prose, no wrapper.
   */
  function buildCommandEnvelope({ commandId, seat, nonce, frame, returnState, payload }) {
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

    let envelope =
      "[" + CMD_VERSION + "]\n" +
      "CMD: " + cmd + "\n" +
      "SEAT: " + st + "\n" +
      "NONCE: " + nn + "\n" +
      "FRAME: " + fr + "\n" +
      "RETURN_STATE: " + rs + "\n";

    if (payload && typeof payload === "object") {
      const validation = validatePayload(cmd, payload);
      if (!validation.valid) {
        throw new Error(validation.reason);
      }
      try {
        envelope += "PAYLOAD: " + JSON.stringify(payload) + "\n";
      } catch (e) {
        throw new Error("PAYLOAD_SERIALIZATION_FAILED");
      }
    }

    envelope += CMD_CLOSE;
    return envelope;
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
    let foundOpen = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (current === null) {
        if (line === ACK_OPEN) {
          current = [];
          foundOpen = true;
        }
        continue;
      }
      if (line === ACK_CLOSE) {
        blocks.push(current.join("\n"));
        current = null;
        foundOpen = false;
        continue;
      }
      current.push(rawLine);
    }
    const truncated = foundOpen && current !== null ? current.join("\n") : null;
    return { blocks, truncated };
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
    const raw = extractAckBlocks(text);
    const truncated = raw.truncated;
    const blocks = raw.blocks || raw;
    for (const block of blocks) {
      const parsed = parseAckBlock(block);
      if (parsed.ok) acks.push(parsed.ack);
      else rejected.push({ reason: parsed.reason, block });
    }
    return { acks, rejected, truncated };
  }

  /*
   * SEAT RESOLUTION — the identity contract.
   *
   * Browser/model surface != seat. ChatGPT and Kimi are runtime SURFACES. Coda,
   * Enzo, Serafina and the rest are IDENTITIES. The bar follows the active
   * identity/session; it must never default to a hardcoded one. A hardcoded
   * DEFAULT_SEAT="CODA" shipped until v1.5.1 and made the bar silently address
   * commands as Coda regardless of who was actually driving.
   *
   * Resolution is by precedence over the frozen state-field vocabulary. The field
   * names live in an array (and are referenced through it) rather than as literals
   * in the logic below, so this stays pure transport vocabulary and adds no
   * conditional-logic surface on governance terms.
   */
  const SEAT_FIELDS = ["PRIMARY_SEAT", "AUTHORITY", "SEAT"];

  function resolveSeatToken(state) {
    if (!state || typeof state !== "object") return null;
    for (const field of SEAT_FIELDS) {
      const raw = state[field];
      if (raw === null || raw === undefined) continue;
      const token = String(raw).trim().toUpperCase();
      if (token && /^[A-Z][A-Z0-9_]*$/.test(token)) return token;
    }
    return null;
  }

  return {
    CMD_VERSION,
    CMD_CLOSE,
    ACK_VERSION,
    ACK_OPEN,
    ACK_CLOSE,
    FRAME_CURRENT,
    CONTROLS,
    VERNACULAR_CONTROLS,
    SESSION_TOOLS,
    CONTROL_IDS,
    RETURN_STATE_DEFAULTS,
    VALID_RESULTS,
    STATE_FIELDS,
    STATE_HEADER_FIELDS,
    SEAT_FIELDS,
    resolveSeatToken,
    FRESHNESS_STATES,
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

/*
 * Browser global. The panel (sidebar/panel.html) is a separate document from the
 * background page and loads this file itself via <script src="../lib/protocol.js">.
 * A top-level `const` alone is a script-scoped lexical binding and is NOT visible as
 * a property, so the panel could never read it. Publish it explicitly.
 */
if (typeof globalThis !== "undefined") {
  globalThis.GCEProtocolModule = GCEProtocol;
}
