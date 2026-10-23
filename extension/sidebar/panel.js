"use strict";

(function() {
  // No DEFAULT_SEAT. The panel never chooses the identity — the background resolves
  // it from authoritative state. A hardcoded default here shipped until v1.5.1 and
  // made the surface address commands as one seat regardless of who was driving.
  // The panel header likewise reads PRIMARY_SEAT/AUTHORITY off the live snapshot.
  const el = {};

  let currentSnapshot = null;
  let transportState = "IDLE";
  let lastNonce = null;
  let pendingCommand = null;
  let holdLatched = false;
  let holdPending = false;
  let expansionState = localStorage.getItem("gce_panel_expanded") === "true";
  const buttonStates = {};
  let observedState = null;
  let observedSeen = false;
  let transportClearTimeout = null;

  /*
   * DON HARDWIRE (1.7.4) — the literal code each button stages.
   * These are intentionally dumb text inserters. No bootstrap routing, no
   * command envelope, no ACK, no state mutation, no seat inference. A button
   * named CAPISCE must stage CAPISCE. Anything else is the bug Don reported.
   */
  const SIMPLE_TEXT = {
    CAPISCE: "CAPISCE",
    HOLD: "HOLD",
    BRANCH: "BRANCH",
    RECENTER_SESSION: "RE-CENTER",
    PARK: "PARK",
    ANCHOR_COMMIT: "ANCHOR",
    SHOW_STATE: "CHECKPOINT",
    PROMOTE: "PROMOTE",
    SUPERSEDE: "SUPERSEDE",
    END_SESSION: "END SESSION",
    REASSERT_FRAME: "FRAME",
    CREATE_HANDOFF: "HANDOFF",
    RELEASE_HOLD: "RELEASE HOLD",
    RESUME_PARKED: "RESUME",
    RELOAD_BOOTSTRAP: "LOAD BOOTSTRAP"
  };

  /*
   * DON CORRECTION (1.7.4) — SAY WHAT ACTUALLY HAPPENED.
   * The old code only ever said "staged" or "Stage error". When the content
   * script refused (COMPOSER_OCCUPIED) the panel printed a bare error code and
   * the button looked dead — which is precisely the report: "Anchor doesn't
   * work. Checkpoint doesn't work." Now the panel reports the real outcome,
   * names any replaced draft, and shows the composer verdict.
   */
  async function stageSimpleText(text) {
    try {
      setStatus("Staging " + text + "...");
      renderTransportHealth("PENDING");
      const r = await browser.runtime.sendMessage({ type: "GCE_LOAD_BOOTSTRAP", text });
      if (r && r.ok) {
        renderTransportHealth("IDLE");
        const replaced = r.replacedDraftLength || 0;
        setStatus(
          text + " staged" +
          (replaced > 0 ? " (replaced your " + replaced + "-char draft)" : "") +
          " — review composer, press Enter"
        );
      } else {
        renderTransportHealth("REJECTED");
        const err = r && r.error ? r.error : JSON.stringify(r);
        setStatus(text + " FAILED: " + err + " — nothing staged");
      }
    } catch (e) {
      renderTransportHealth("TRANSPORT_FAIL");
      setStatus(text + " FAILED: " + String(e && e.message ? e.message : e));
    }
  }

  const VERNACULAR = [
    { id: "CAPISCE", label: "CAPISCE" },
    { id: "HOLD", label: "HOLD", supportsLatch: true },
    { id: "BRANCH", label: "BRANCH" },
    { id: "RECENTER_SESSION", label: "RE-CENTER" },
    { id: "PARK", label: "PARK" }
  ];

  function getSessionTools() {
    if (typeof GCEProtocolModule !== "undefined" && GCEProtocolModule && GCEProtocolModule.SESSION_TOOLS) {
      return GCEProtocolModule.SESSION_TOOLS.map(t => ({ id: t.id, label: t.label }));
    }
    return [
      { id: "RELOAD_BOOTSTRAP", label: "Bootstrap" },
      { id: "REASSERT_FRAME", label: "Frame" },
      { id: "SHOW_STATE", label: "State" },
      { id: "ANCHOR_COMMIT", label: "Checkpoint" },
      { id: "CREATE_HANDOFF", label: "Handoff" },
      { id: "PROMOTE", label: "Promote" },
      { id: "SUPERSEDE", label: "Supersede" },
      { id: "END_SESSION", label: "End" },
      { id: "RELEASE_HOLD", label: "Release Hold" },
      { id: "RESUME_PARKED", label: "Resume" }
    ];
  }

  function initElements() {
    el.trustStrip = document.getElementById("trust-strip");
    el.tsSeat = document.getElementById("ts-seat-val");
    el.tsMode = document.getElementById("ts-mode-val");
    el.tsFreshness = document.getElementById("ts-freshness-val");
    el.tsBranch = document.getElementById("ts-branch-val");
    el.tsBlocker = document.getElementById("ts-blocker");
    el.tsBlockerVal = document.getElementById("ts-blocker-val");
    el.tsParked = document.getElementById("ts-parked");
    el.tsParkedVal = document.getElementById("ts-parked-val");
    el.transportHealth = document.getElementById("transport-health");
    el.thStatus = document.getElementById("th-status");
    el.sessionHint = document.getElementById("session-hint");
    el.vernacularGrid = document.getElementById("vernacular-grid");
    el.donTable = document.getElementById("don-table");
    el.btnExpand = document.getElementById("btn-expand");
    el.tableContent = document.getElementById("table-content");
    el.dlWhere = document.getElementById("dl-where");
    el.dlContext = document.getElementById("dl-context");
    el.dlExceptions = document.getElementById("dl-exceptions");
    el.dlWhat = document.getElementById("dl-what");
    el.parkShelf = document.getElementById("park-shelf");
    el.parkShelfHdr = document.getElementById("park-shelf-hdr");
    el.parkTiles = document.getElementById("park-tiles");
    el.nextActionValue = document.getElementById("next-action-value");
    el.nextActionActions = document.getElementById("next-action-actions");
    el.sessionTools = document.getElementById("session-tools");
    el.toolsToggle = document.getElementById("tools-toggle");
    el.toolsGrid = document.getElementById("tools-grid");
    el.tsObjectiveVal = document.getElementById("ts-objective-val");
    el.statusLine = document.getElementById("status-line");
    el.logDlg = document.getElementById("logdlg");
    el.logBody = document.getElementById("logbody");
    el.btnLog = document.getElementById("btn-log");
    el.btnLogClose = document.getElementById("btn-log-close");
    el.branchDlg = document.getElementById("branch-dlg");
    el.branchName = document.getElementById("branch-name");
    el.branchOrigin = document.getElementById("branch-origin");
    el.btnBranchClose = document.getElementById("btn-branch-close");
    el.btnBranchCancel = document.getElementById("btn-branch-cancel");
    el.btnBranchConfirm = document.getElementById("btn-branch-confirm");
    el.parkDlg = document.getElementById("park-dlg");
    el.parkList = document.getElementById("park-list");
    el.btnParkClose = document.getElementById("btn-park-close");
el.btnParkShelf = document.getElementById("ts-parked");
    el.btnParkClose = document.getElementById("btn-park-close");
    el.btnEndClose = document.getElementById("btn-end-close");
    el.btnEndCancel = document.getElementById("btn-end-cancel");
el.btnEndConfirm = document.getElementById("btn-end-confirm");
  }

  function fmtFreshness(val) {
    if (!val) return "UNKNOWN";
    return val.toUpperCase();
  }

  /*
   * EXCEPTION CHIP RULING (Serafina, final):
   *   A count renders ONLY when the seat actually sent a count (number, or an
   *   array whose length is known). Prose BLOCKERS gets a BARE flag only —
   *   never a number inferred from prose, because guessing a count the seat
   *   never sent would be fabrication.
   *   Chips glance; rows explain.
   */
  function countFromField(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (Array.isArray(raw)) return raw.length;
    const s = String(raw).trim();
    if (s === "") return null;
    // A bare integer (optionally signed) is a count the seat sent. Anything
    // containing a digit *and* non-numeric characters is prose, not a count.
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    return null;
  }

  /*
   * Set an exception chip's content: a drawn flag plus a count ONLY when the seat
   * actually sent one. The flag is a CSS element, not a typed glyph — U+2691 is
   * missing from many system fonts and would render as an invisible blank box.
   */
  function setChip(el, count) {
    el.innerHTML = "";
    const flag = document.createElement("i");
    flag.className = "chip-flag";
    flag.setAttribute("aria-hidden", "true");
    el.appendChild(flag);
    if (count !== null) {
      const n = document.createElement("span");
      n.textContent = String(count);
      el.appendChild(n);
    }
    el.setAttribute("aria-label", count === null ? "exception present" : "exception present: " + count);
  }

  function handleObservedState(observed) {
    if (!observed) return;
    const seat = observed.SEAT || observed.seat || null;
    const mode = observed.MODE || observed.mode || null;
    const obj = observed.OBJECTIVE || observed.objective || null;
    /* DON CORRECTION (1.7.4): the panel must not blank the trust strip on the
     * very next poll. Observed state arriving is a real answer; render it and
     * stop the hint from re-appearing. */
    if (!seat && !mode && !obj && !observed.PROJECT && !observed.WORKSTREAM &&
        !observed.NEXT_ACTION && !observed.NEXT_ROUTE && !observed.BLOCKERS &&
        !observed.DON_INTENT && !observed.STATUS) return;
    observedState = observed;
    observedSeen = true;
    /* DON CORRECTION (1.7.5): re-render the full surface from observed. The
     * old code poked three text nodes and stopped, so NEXT ACTION and the
     * STATE cards kept showing "—" even though the header had supplied them. */
    if (currentSnapshot) {
      renderDonTable(currentSnapshot);
    }
    if (el.tsSeat) {
      el.tsSeat.textContent = seat || "—";
      el.tsSeat.classList.add("observed");
    }
    if (el.tsMode) {
      el.tsMode.textContent = mode || "—";
      el.tsMode.classList.add("observed");
    }
    if (el.tsObjectiveVal) {
      el.tsObjectiveVal.textContent = obj || "—";
      el.tsObjectiveVal.classList.add("observed");
    }
    // Hide hint now that observed has landed
    el.sessionHint.classList.add("hidden");
  }

  function renderTrustStrip(snapshot) {
    const s = snapshot || {};
    // Clear .observed classes on validated render
    if (el.tsSeat) el.tsSeat.classList.remove("observed");
    if (el.tsMode) el.tsMode.classList.remove("observed");
    if (el.tsObjectiveVal) el.tsObjectiveVal.classList.remove("observed");

    // Use observed as display floor when snapshot is empty
    const hasValidatedSeat = s.PRIMARY_SEAT || s.AUTHORITY;
    const obs = observedState || {};
    const obsSeat = obs.SEAT || obs.seat || null;
    /* DON CORRECTION (1.7.5): MODE prefers the session header's own line. The
     * header says "Mode: Standard operating state" and separately
     * "Status: ACTIVE". Showing the header Mode is the answer to the question
     * Don asked; do not substitute STATUS for it.
     *
     * DON CORRECTION (1.7.6): STATUS is the only floor left when the header has
     * no "Mode:" line. An empty MODE beside a populated SEAT read as "the seat
     * is unknown" when in fact the seat told us it is ACTIVE. */
    const obsMode = obs.MODE || obs.mode || obs.STATUS || obs.status || null;
    const obsObj = obs.OBJECTIVE || obs.objective || null;

    /*
     * DON APPROVED (1.7.9) — EMPTY STATE IS A STATE, SAY SO PLAINLY.
     *
     * A new chat legitimately has no seat. Rendering that as a bare "—" in three
     * fields read as "the panel is broken" — which is exactly how the earlier
     * chrome-scrape looked, and how a genuinely clean panel now looks. The
     * truthful, calm answer is "no seat yet" / "idle", not a dash and not an
     * invented identity.
     *
     * Note what this does NOT do: it never fills SEAT with a guess. "no seat yet"
     * is a statement about OBSERVATION (nothing has spoken), not a claim about
     * who is driving. MODE's idle label is separate for the same reason.
     */
    const seatText = s.PRIMARY_SEAT || s.AUTHORITY || obsSeat;
    el.tsSeat.textContent = seatText || "no seat yet";
    el.tsSeat.classList.toggle("calm", !seatText);

    let modeText = s.MODE || obsMode;
    if (holdLatched) {
      modeText = modeText ? modeText + " · HOLD" : "HOLD";
    } else if (!modeText) {
      modeText = "idle";
    }
    el.tsMode.textContent = modeText;
    el.tsMode.classList.toggle("calm", !s.MODE && !obsMode && !holdLatched);

    /* DON CORRECTION (1.7.5): freshness must never read UNKNOWN once the seat has
     * spoken. The header carrying "Status: ACTIVE" IS a live answer; showing
     * STATE UNKNOWN next to a fully populated seat was the contradiction Don
     * photographed. */
    let freshness;
    if (obsSeat || obsMode || obsObj) {
      freshness = hasValidatedSeat ? fmtFreshness(s.STATE_FRESHNESS) : "observed";
      if (freshness === "UNKNOWN" || freshness === "unknown") freshness = "observed";
    } else if (!hasValidatedSeat && !s.STATE_FRESHNESS) {
      /* DON APPROVED (1.7.9): nothing observed and nothing validated. "unknown"
       * implies a measurement failed; nothing was measured. Say "idle" — same
       * calm styling, but it is the honest word. */
      freshness = "idle";
    } else {
      freshness = fmtFreshness(s.STATE_FRESHNESS);
    }
    el.tsFreshness.textContent = freshness;
    el.tsFreshness.className = "ts-value freshness-" + freshness.toLowerCase();

    // DON APPROVED (1.7.9): same ruling as SEAT — "no branch" beats a bare dash.
    const branchText = s.CURRENT_BRANCH || s.CURRENT_ANCHOR;
    el.tsBranch.textContent = branchText || "no branch";
    el.tsBranch.classList.toggle("calm", !branchText);

    // DON CORRECTION 7 — the objective slot always renders. Calm when absent.
    // DON APPROVED (1.7.9): "no objective" is already the honest empty state.
    // Left as-is deliberately — it was never the confusing one.
    const objective = val(s.OBJECTIVE) || obsObj;
    el.tsObjectiveVal.textContent = objective === null ? "no objective" : objective;
    el.tsObjectiveVal.classList.toggle("calm", objective === null);

    // Blockers -> amber exception chip. Bare flag when the seat sent prose.
    const hasBlockers =
      s.BLOCKERS !== null && s.BLOCKERS !== undefined &&
      String(s.BLOCKERS).trim() !== "" &&
      String(s.BLOCKERS).trim() !== "0";
    if (hasBlockers) {
      el.tsBlocker.classList.remove("hidden");
      setChip(el.tsBlockerVal, countFromField(s.BLOCKERS));
    } else {
      el.tsBlocker.classList.add("hidden");
    }

    // Parked -> chip count from PARKED, or from shelf tiles when present.
    const parkedCount = countFromField(s.PARKED) ??
      (Array.isArray(s.PARKED_ITEMS) ? s.PARKED_ITEMS.length : null);
    if (parkedCount !== null && parkedCount > 0) {
      el.tsParked.classList.remove("hidden");
      setChip(el.tsParkedVal, parkedCount);
    } else {
      el.tsParked.classList.add("hidden");
    }

    /* Session hint: show only when nothing validated AND no observed state seen.
     * DON APPROVED (1.7.9): the strip now says "no seat yet" itself, so the
     * hint's job is no longer to announce emptiness. It explains the ONE action
     * that fixes it — TOOLS > State begins a session — so it stays, but it must
     * not read as an error. */
    const hasValidState = (s.PRIMARY_SEAT || s.AUTHORITY || s.OBJECTIVE) && freshness !== "unknown";
    const showHint = !hasValidState && !observedSeen && freshness !== "idle";
    el.sessionHint.classList.toggle("hidden", !showHint);
  }

  function renderTransportHealth(state) {
    transportState = state;
    el.thStatus.textContent = state;
    el.transportHealth.className = "transport-health transport-" + state.toLowerCase().replace(/\s+/g, "-");
  }

  function setButtonState(cmdId, state) {
    buttonStates[cmdId] = state;
    const btns = document.querySelectorAll(`[data-cmd="${cmdId}"]`);
    btns.forEach(btn => {
      btn.classList.remove("btn-idle", "btn-pending", "btn-success", "btn-rejected", "btn-failed", "btn-disabled");
      btn.classList.add("btn-" + state);
      btn.disabled = state === "pending" || state === "disabled";
    });
  }

  function getButtonState(cmdId) {
    return buttonStates[cmdId] || "idle";
  }

  function renderVernacularRow() {
    el.vernacularGrid.innerHTML = "";
    for (const v of VERNACULAR) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vn-btn-grid";
      btn.dataset.cmd = v.id;
      btn.dataset.label = v.label;
      if (v.id === "HOLD" && holdLatched) {
        btn.classList.add("latched");
      }
      if (v.id === "HOLD" && holdPending) {
        btn.classList.add("pending");
      }
      const span = document.createElement("span");
      span.className = "vn-label";
      span.textContent = v.label;
      btn.appendChild(span);
      btn.addEventListener("click", () => handleVernacularClick(v.id));
      el.vernacularGrid.appendChild(btn);
    }
  }

  function handleVernacularClick(cmdId) {
    if (cmdId === "CAPISCE" || cmdId === "RECENTER_SESSION" || cmdId === "PARK") {
      /* THE ORIGINAL DEFECT (fixed here, shipped broken in every build):
       * these three buttons called loadBootstrap(<some seat>) — CAPISCE loaded
       * Coda, RE-CENTER loaded Enzo, PARK loaded Vittorio. A button labelled
       * with a command word silently substituted a seat identity. That is
       * exactly what Don reported: press CAPISCE, get Coda.
       * The buttons now stage the literal code, same as every other control.
       * Seat identity is resolved by the seat from state, never by a button. */
      stageSimpleText(SIMPLE_TEXT[cmdId] || cmdId);
      return;
    }
    if (cmdId === "HOLD") {
      holdLatched = !holdLatched;
      renderVernacularRow();
      stageSimpleText(holdLatched ? SIMPLE_TEXT.HOLD : SIMPLE_TEXT.RELEASE_HOLD);
      return;
    }
    stageSimpleText(SIMPLE_TEXT[cmdId] || cmdId.replace(/_/g, " "));
  }

  /*
   * A row is only rendered when it carries a value. DON CORRECTION 3: card height
   * follows content, so null fields must not reserve vertical space. EXCEPTIONS is
   * the one exception by ruling — its card is always present and says "none" calmly.
   */
  function val(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s === "" || s === "0" && false) return null;
    return s;
  }

  function rowList(pairs) {
    return pairs.filter(([, v]) => val(v) !== null);
  }

  function renderDonTable(snapshot) {
    const s = snapshot || {};

    /* DON CORRECTION (1.7.5): observed is the display floor for every field.
     * A seat that has stated a header but not yet sent a validated ACK still
     * has a real answer. Falling back to observed keeps the STATE cards from
     * rendering empty during exactly the period Don is reading them. */
    const o = observedState || {};
    const pick = (v, keys) => v !== undefined && v !== null ? v
      : keys.map(k => o[k]).find(x => x !== undefined && x !== null && String(x).trim() !== "") || null;

    // --- WHERE AM I. Objective lives in the top strip (Don correction 7).
    const whereRows = rowList([
      ["Mode", val(pick(s.MODE, ["MODE"]))],
      ["Status", val(pick(s.SESSION_STATUS, ["STATUS"]))],
      ["Branch", val(pick(s.CURRENT_BRANCH, ["CURRENT_BRANCH"]))],
      ["Origin Anchor", val(pick(s.ORIGINATING_ANCHOR, ["CURRENT_ANCHOR"])), "mono-label", "mono-value"],
      ["Promoted", val(s.PROMOTED_CURRENT)],
      ["Confidence", val(s.CONFIDENCE) ? s.CONFIDENCE + "%" : null],
      ["Freshness", val(s.STATE_FRESHNESS)],
      ["State As Of", val(s.STATE_AS_OF), "mono-label", "mono-value"]
    ]);
    renderDlSection(el.dlWhere, whereRows);
    markSectionRows(el.dlWhere.closest(".table-section"), whereRows.length > 0);

    // Absorbed post-design schema fields, on one compact diagnostics line.
    const ctxRows = rowList([
      ["Session", val(s.SESSION_ID)],
      ["Status", val(pick(s.SESSION_STATUS, ["STATUS"]))],
      ["Project", val(pick(s.PROJECT, ["PROJECT"]))],
      ["Workstream", val(pick(s.WORKSTREAM, ["WORKSTREAM"]))]
    ]);
    renderDlSection(el.dlContext, ctxRows.map(([k, v]) => [k, v, "", ""]));

    // --- EXCEPTIONS. Rows only when values exist; card always present.
    const exRows = rowList([
      ["⚑ Blockers", val(pick(s.BLOCKERS, ["BLOCKERS"])), "", "exception-value"],
      ["Handoff", val(s.HANDOFF_STATE)],
      ["Blocker Route", val(s.BLOCKER_ROUTE)],
      ["Parked", val(s.PARKED)]
    ]);
    if (exRows.length === 0) {
      renderDlSection(el.dlExceptions, [["Exceptions", "none — calm", "", ""]]);
    } else {
      renderDlSection(el.dlExceptions, exRows);
    }

    // --- WHAT IS HAPPENING.
    const whatRows = rowList([
      ["Current Task", val(pick(s.CURRENT_TASK, ["CURRENT_TASK"])), "", "sub-value"],
      ["Don Intent", val(pick(s.DON_INTENT, ["DON_INTENT"])), "", "sub-value"],
      ["Checkpoint", val(s.CHECKPOINT)],
      ["Next Route", val(pick(s.NEXT_ROUTE, ["NEXT_ACTION"]))],
      ["Evidence", val(pick(null, ["EVIDENCE"])), "", "sub-value"]
    ]);
    renderDlSection(el.dlWhat, whatRows);
    markSectionRows(el.dlWhat.closest(".table-section"), whatRows.length > 0);

    renderParkShelf(s);
    renderNextAction(s);
  }

  function markSectionRows(section, hasRows) {
    if (section) section.classList.toggle("no-rows", !hasRows);
  }

  /*
   * Park Shelf — parked work is a shelf, not a line item.
   * Renders only when the seat actually sent PARKED_ITEMS. If seats emit a plain
   * string instead of a JSON array the shelf stays empty: honest, not fabricated.
   */
  function renderParkShelf(s) {
    const items = Array.isArray(s.PARKED_ITEMS) ? s.PARKED_ITEMS : [];
    el.parkShelf.classList.toggle("hidden", items.length === 0);
    if (items.length === 0) return;

    el.parkTiles.innerHTML = "";
    for (const p of items) {
      const tile = document.createElement("div");
      tile.className = "park-tile";

      const label = document.createElement("span");
      label.className = "park-tile-label";
      label.textContent = p?.label || p?.identity || "Unknown";
      tile.appendChild(label);

      const metaParts = [];
      const origin = p?.origin || p?.provenance;
      if (origin) metaParts.push("from ▸ " + origin);
      const fresh = p?.freshness || p?.status;
      if (fresh) metaParts.push(String(fresh).toUpperCase());
      const meta = document.createElement("span");
      meta.className = "park-tile-meta";
      meta.textContent = metaParts.join("  ·  ") || "—";
      tile.appendChild(meta);

      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "tool-btn resume-btn";
      resume.textContent = "Resume";
      resume.addEventListener("click", () => {
        if (p?.identity) {
          issueCommand("RESUME_PARKED", true, { parkedIdentity: p.identity });
        }
      });
      tile.appendChild(resume);

      el.parkTiles.appendChild(tile);
    }
    el.parkShelfHdr.textContent = "Park Shelf ⏸ " + items.length;
  }

  /* NEXT ACTION — promoted out of the field grid into its own bar, with the
   * lifecycle actions that follow from it. */
  const NEXT_ACTION_CONTROLS = [
    { id: "ANCHOR_COMMIT", label: "Anchor" },
    { id: "SHOW_STATE", label: "Checkpoint" },
    { id: "PROMOTE", label: "Promote" },
    { id: "SUPERSEDE", label: "Supersede" },
    { id: "END_SESSION", label: "End Session" }
  ];

  function renderNextAction(s) {
    /* DON CORRECTION (1.7.5): observed is a legitimate display floor here too.
     * The session header carries "Next Action:", and with no validated ACK
     * state yet it was the only real answer available. Rendering "—" while the
     * seat had already stated the next action was the misleading case. */
    const obs = observedState || {};
    const na = s.NEXT_ACTION || obs.NEXT_ACTION || obs.NEXT_ROUTE || null;
    el.nextActionValue.textContent =
      na === null || na === undefined || String(na).trim() === "" ? "—" : na;

    el.nextActionActions.innerHTML = "";
    for (const c of NEXT_ACTION_CONTROLS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.dataset.cmd = c.id;
      btn.textContent = c.label;
      btn.addEventListener("click", () => handleToolClick(c.id));
      setButtonState(c.id, getButtonState(c.id));
      el.nextActionActions.appendChild(btn);
    }
  }

  function renderDlSection(container, pairs) {
    container.innerHTML = "";
    for (const [dt, dd, dtClass, ddClass] of pairs) {
      const d = document.createElement("dt");
      if (dtClass) d.className = dtClass;
      d.textContent = dt;
      const ddEl = document.createElement("dd");
      if (ddClass) ddEl.className = ddClass;
      ddEl.textContent = dd;
      container.appendChild(d);
      container.appendChild(ddEl);
    }
  }

  function renderSessionTools() {
    el.toolsGrid.innerHTML = "";
    const tools = getSessionTools();
    for (const t of tools) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.dataset.cmd = t.id;
      btn.textContent = t.label;
      btn.addEventListener("click", () => handleToolClick(t.id));
      el.toolsGrid.appendChild(btn);
    }
  }

  function handleToolClick(cmdId) {
    stageSimpleText(SIMPLE_TEXT[cmdId] || cmdId.replace(/_/g, " "));
  }

  function toggleExpansion() {
    expansionState = !expansionState;
    localStorage.setItem("gce_panel_expanded", expansionState);
    el.donTable.classList.toggle("collapsed", !expansionState);
    el.donTable.classList.toggle("expanded", expansionState);
    el.tableContent.classList.toggle("hidden", !expansionState);
    el.btnExpand.setAttribute("aria-expanded", expansionState);
    el.btnExpand.querySelector(".toggle-icon").textContent = expansionState ? "▴" : "▾";
  }

  /* Session Tools is a collapsed drawer: maintenance controls serve the surface,
   * they never dominate it. State is per-render, not persisted — depth on demand
   * should not become a remembered preference that hides the surface. */
  function toggleToolsDrawer() {
    const open = el.sessionTools.classList.toggle("open");
    el.toolsToggle.setAttribute("aria-expanded", open);
  }

  function issueCommand(commandId, returnState, payload) {
    pendingCommand = { commandId };
    renderTransportHealth("PENDING");
    setButtonState(commandId, "pending");
    if (commandId === "HOLD" || commandId === "RELEASE_HOLD") {
      holdPending = true;
    }
    const msg = {
      type: "GCE_ISSUE",
      commandId,
      returnState
    };
    if (payload) {
      msg.payload = payload;
    }
    browser.runtime.sendMessage(msg).then(resp => {
      if (resp && resp.ok && resp.nonce) {
        lastNonce = resp.nonce;
        pendingCommand.nonce = resp.nonce;
      }
      if (resp && resp.ok) {
        renderTransportHealth("ACK_WAITING");
        setStatus(`Sent ${commandId}, waiting for ACK...`);
      } else {
        renderTransportHealth("TX_FAIL");
        setButtonState(commandId, "failed");
        if (commandId === "HOLD" || commandId === "RELEASE_HOLD") {
          holdPending = false;
          renderVernacularRow();
        }
        const errName = resp?.error || resp?.reason || "UNKNOWN";
        setStatus(errName + (resp?.note ? " — " + resp.note : ""));
      }
    }).catch(err => {
      renderTransportHealth("TX_FAIL");
      setButtonState(commandId, "failed");
      if (commandId === "HOLD" || commandId === "RELEASE_HOLD") {
        holdPending = false;
        renderVernacularRow();
      }
      setStatus("Send failed: " + err.message);
    });
  }

  function generateNonce() {
    return "GCE-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
  }

  function setStatus(msg) {
    el.statusLine.textContent = msg;
  }

  function openBranchDialog() {
    const branch = currentSnapshot?.CURRENT_BRANCH || currentSnapshot?.CURRENT_ANCHOR;
    el.branchOrigin.textContent = branch || "—";
    el.branchName.value = "";
    el.branchDlg.showModal();
  }

  function openParkDialog() {
    renderParkList();
    el.parkDlg.showModal();
  }

  function renderParkList() {
    el.parkList.innerHTML = "";
    const parkedItems = currentSnapshot?.PARKED_ITEMS;
    if (!parkedItems || !Array.isArray(parkedItems) || parkedItems.length === 0) {
      el.parkList.innerHTML = "<div class='park-empty'>No parked lines</div>";
      return;
    }
    for (const pItem of parkedItems) {
      const item = document.createElement("div");
      item.className = "park-item";
      const nameSpan = document.createElement("span");
      nameSpan.className = "park-name";
      nameSpan.textContent = pItem?.label || pItem?.identity || "Unknown";
      const originSpan = document.createElement("span");
      originSpan.className = "park-origin";
      originSpan.textContent = "from " + (pItem?.origin || pItem?.provenance || "—");
      const freshnessSpan = document.createElement("span");
      freshnessSpan.className = "park-freshness";
      freshnessSpan.textContent = pItem?.freshness || pItem?.status || "—";
      const resumeBtn = document.createElement("button");
      resumeBtn.className = "btn-mini resume-btn";
      resumeBtn.textContent = "Resume";
      resumeBtn.addEventListener("click", () => {
        if (pItem?.identity) {
          issueCommand("RESUME_PARKED", true, { parkedIdentity: pItem.identity });
        }
        el.parkDlg.close();
      });
      item.appendChild(nameSpan);
      item.appendChild(originSpan);
      item.appendChild(freshnessSpan);
      item.appendChild(resumeBtn);
      el.parkList.appendChild(item);
    }
  }

  function endItem(label, value) {
    const row = document.createElement("div");
    row.className = "end-item";
    const strong = document.createElement("strong");
    strong.textContent = label + ":";
    row.appendChild(strong);
    // Seat-authored value: textContent only. Never innerHTML.
    row.appendChild(document.createTextNode(" " + value));
    return row;
  }

  function openEndDialog() {
    const s = currentSnapshot || {};
    const blockers = parseInt(s.BLOCKERS, 10) || 0;
    const parked = parseInt(s.PARKED, 10) || 0;
    let checkpoint = s.CHECKPOINT;
    if (!checkpoint || checkpoint === "—" || checkpoint.trim() === "") {
      checkpoint = "Unavailable";
    } else if (/^\d+$/.test(checkpoint.trim())) {
      checkpoint = parseInt(checkpoint, 10);
    }
    const handoff = s.HANDOFF_STATE || "Not ready";

    el.endSummary.innerHTML = "";
    el.endSummary.appendChild(endItem("Blockers", String(blockers)));
    el.endSummary.appendChild(endItem("Parked lines", String(parked)));
    el.endSummary.appendChild(endItem("Checkpoint", String(checkpoint)));
    el.endSummary.appendChild(endItem("Handoff", String(handoff)));

    if (handoff === "ready" || handoff.toLowerCase().includes("ready")) {
      const action = document.createElement("div");
      action.className = "end-action";
      const handoffBtn = document.createElement("button");
      handoffBtn.className = "btn-primary";
      handoffBtn.textContent = "Create Handoff First";
      handoffBtn.addEventListener("click", () => {
        el.endDlg.close();
        issueCommand("CREATE_HANDOFF", true);
      });
      action.appendChild(handoffBtn);
      el.endSummary.appendChild(action);
    }

    el.endDlg.showModal();
  }

  function normalizeSnapshot(snap) {
    if (!snap) return {};
    const raw = snap.lastState?.state || {};
    let parkedItems = raw.PARKED_ITEMS;
    if (typeof parkedItems === "string" && parkedItems.trim()) {
      try {
        const parsed = JSON.parse(parkedItems);
        parkedItems = Array.isArray(parsed) ? parsed : null;
      } catch (e) {
        parkedItems = null;
      }
    }
    return {
      ...raw,
      PARKED_ITEMS: parkedItems,
      topState: snap.topState,
      session: snap.session,
      stateAgeMs: snap.stateAgeMs,
      outstandingCount: snap.outstandingCount,
      latest: snap.latest
    };
  }

  function handleSnapshot(snap) {
    currentSnapshot = normalizeSnapshot(snap);
    renderTrustStrip(currentSnapshot);
    renderDonTable(currentSnapshot);
    setStatus("State received");
    // Self-clearing: if TX_FAIL is showing, clear it on successful poll
    if (transportState === "TX_FAIL" || transportState === "TRANSPORT_FAIL") {
      clearTimeout(transportClearTimeout);
      transportClearTimeout = setTimeout(() => {
        renderTransportHealth("IDLE");
      }, 1500);
    }
  }

  function handleAck(ack) {
    if (ack.nonce === lastNonce) {
      const cmd = pendingCommand?.commandId;
      pendingCommand = null;
      if (ack.result === "ACCEPTED") {
        renderTransportHealth("IDLE");
        setButtonState(cmd, "success");
        setStatus(ack.cmd + " accepted");
        if (cmd === "HOLD" || cmd === "RELEASE_HOLD") {
          if (cmd === "HOLD") {
            holdLatched = true;
            holdPending = false;
          } else {
            holdLatched = false;
            holdPending = false;
          }
          renderVernacularRow();
        }
        if (ack.state) {
          handleSnapshot(ack.state);
        }
      } else if (ack.result === "PARTIAL") {
        renderTransportHealth("IDLE");
        setButtonState(cmd, "success");
        setStatus(ack.cmd + " partial: " + (ack.note || ""));
      } else if (ack.result === "REJECTED" || ack.result === "UNKNOWN_COMMAND" || ack.result === "AMBIGUOUS_STATE") {
        renderTransportHealth("REJECTED");
        setButtonState(cmd, "rejected");
        setStatus(ack.cmd + " rejected: " + (ack.note || ack.result));
        if (cmd === "HOLD" || cmd === "RELEASE_HOLD") {
          holdPending = false;
          renderVernacularRow();
        }
      } else {
        renderTransportHealth("TX_FAIL");
        setButtonState(cmd, "failed");
        setStatus(ack.cmd + " " + ack.result);
      }
    }
  }

  function setupEventListeners() {
    el.btnExpand.addEventListener("click", toggleExpansion);
    el.toolsToggle.addEventListener("click", toggleToolsDrawer);
    el.toolsToggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleToolsDrawer();
      }
    });
    el.btnLog.addEventListener("click", () => {
      el.logDlg.showModal();
    });
    el.btnLogClose.addEventListener("click", () => el.logDlg.close());
    el.btnBranchClose.addEventListener("click", () => el.branchDlg.close());
    el.btnBranchCancel.addEventListener("click", () => el.branchDlg.close());
    el.btnBranchConfirm.addEventListener("click", () => {
      const name = el.branchName.value.trim();
      const origin = el.branchOrigin.textContent;
      issueCommand("BRANCH", true, { branchName: name, origin: origin || null });
      el.branchDlg.close();
    });
    // DON CORRECTION 6 — the parked chip reveals the park shelf. The footer button
    // that used to sit detached from it is gone.
    el.btnParkShelf.addEventListener("click", () => {
      if (!el.tableContent.classList.contains("hidden")) {
        el.parkShelf.scrollIntoView({ block: "nearest" });
        el.parkShelf.classList.add("flash");
        setTimeout(() => el.parkShelf.classList.remove("flash"), 700);
      }
      openParkDialog();
    });
    el.btnParkClose.addEventListener("click", () => el.parkDlg.close());
    el.btnEndClose.addEventListener("click", () => el.endDlg.close());
    el.btnEndCancel.addEventListener("click", () => el.endDlg.close());
    el.btnEndConfirm.addEventListener("click", () => {
      issueCommand("END_SESSION", true);
      el.endDlg.close();
    });

    if (expansionState) {
      el.donTable.classList.add("expanded");
      el.donTable.classList.remove("collapsed");
      el.tableContent.classList.remove("hidden");
      el.btnExpand.setAttribute("aria-expanded", "true");
      el.btnExpand.querySelector(".toggle-icon").textContent = "▴";
    }

    // Bootstrap button bindings
    document.querySelectorAll("[data-bootstrap]").forEach(b =>
      b.addEventListener("click", () => loadBootstrap(b.dataset.bootstrap)));
  }

  async function loadBootstrap(seat) {
    try {
      const text = await (await fetch(`../bootstraps/${seat}.md`)).text();
      if (text.includes("PLACEHOLDER")) {
        setStatus("Bootstrap unavailable — placeholder only");
        return;
      }
      setStatus("Loading bootstrap...");
      const r = await browser.runtime.sendMessage({ type: "GCE_LOAD_BOOTSTRAP", text });
      setStatus("Bootstrap result: " + JSON.stringify(r));
      if (r && r.ok) {
        setStatus("Bootstrap staged — review composer, press Enter");
      } else {
        setStatus("Bootstrap error: " + (r && r.error ? r.error : JSON.stringify(r)));
      }
    } catch (e) {
      setStatus("Bootstrap load error: " + String(e && e.message ? e.message : e));
    }
  }

  function listenForMessages() {
    browser.runtime.onMessage.addListener((msg, sender) => {
      if (!msg) return;
      if (msg.type === "GCE_SNAPSHOT" && msg.snapshot) {
        handleSnapshot(msg.snapshot);
      } else if (msg.type === "GCE_ACK" && msg.ack) {
        handleAck(msg.ack);
      } else if (msg.type === "GCE_OBSERVED_STATE") {
        handleObservedState(msg.observed || {});
      }
    });
  }

  function init() {
    initElements();
    renderVernacularRow();
    renderSessionTools();
    setupEventListeners();
    listenForMessages();
    // Open a GCE session on init so the strip has something to show
    browser.runtime.sendMessage({ type: "GCE_OPEN_SESSION" }).then((snap) => {
      if (snap) handleSnapshot(snap);
    }).catch(() => {
      // Silent fail - sidebar will show empty until snapshot arrives
    });
    // Poll for snapshots every second (restored from v1.2.0)
    setInterval(async () => {
      try {
        const s = await browser.runtime.sendMessage({ type: "GCE_GET_SNAPSHOT" });
        if (s) handleSnapshot(s);
      } catch (e) {
        // Silent fail on polling errors
      }
    }, 1000);
    setStatus("Ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();