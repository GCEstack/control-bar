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
    el.vernacularRow = document.getElementById("vernacular-row");
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

  function renderTrustStrip(snapshot) {
    const s = snapshot || {};
    el.tsSeat.textContent = s.PRIMARY_SEAT || s.AUTHORITY || "—";
    let modeText = s.MODE || "—";
    if (holdLatched) {
      modeText = modeText ? modeText + " · HOLD" : "HOLD";
    }
    el.tsMode.textContent = modeText;

    const freshness = fmtFreshness(s.STATE_FRESHNESS);
    el.tsFreshness.textContent = freshness;
    el.tsFreshness.className = "ts-value freshness-" + freshness.toLowerCase();

    el.tsBranch.textContent = s.CURRENT_BRANCH || s.CURRENT_ANCHOR || "—";

    // DON CORRECTION 7 — the objective slot always renders. Calm when absent.
    const objective = val(s.OBJECTIVE);
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
    el.vernacularRow.innerHTML = "";
    for (const v of VERNACULAR) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vn-btn";
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
      el.vernacularRow.appendChild(btn);
    }
  }

  function handleVernacularClick(cmdId) {
    if (cmdId === "HOLD") {
      holdLatched = !holdLatched;
      renderVernacularRow();
      if (holdLatched) {
        issueCommand("HOLD", true);
        setStatus("HOLD sent, waiting for ACK...");
      } else {
        issueCommand("RELEASE_HOLD", true);
        setStatus("HOLD release sent, waiting for ACK...");
      }
    } else if (cmdId === "BRANCH") {
      openBranchDialog();
    } else if (cmdId === "PARK") {
      issueCommand("PARK", true);
    } else {
      issueCommand(cmdId, true);
    }
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

    // --- WHERE AM I. Objective lives in the top strip (Don correction 7).
    const whereRows = rowList([
      ["Mode", val(s.MODE)],
      ["Branch", val(s.CURRENT_BRANCH)],
      ["Origin Anchor", val(s.ORIGINATING_ANCHOR), "mono-label", "mono-value"],
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
      ["Status", val(s.SESSION_STATUS)],
      ["Project", val(s.PROJECT)],
      ["Workstream", val(s.WORKSTREAM)]
    ]);
    renderDlSection(el.dlContext, ctxRows.map(([k, v]) => [k, v, "", ""]));

    // --- EXCEPTIONS. Rows only when values exist; card always present.
    const exRows = rowList([
      ["⚑ Blockers", val(s.BLOCKERS), "", "exception-value"],
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
      ["Current Task", val(s.CURRENT_TASK), "", "sub-value"],
      ["Don Intent", val(s.DON_INTENT), "", "sub-value"],
      ["Checkpoint", val(s.CHECKPOINT)],
      ["Next Route", val(s.NEXT_ROUTE)]
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
    const na = s.NEXT_ACTION;
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
    if (cmdId === "END_SESSION") {
      openEndDialog();
    } else if (cmdId === "PROMOTE") {
      const promoted = currentSnapshot?.PROMOTED_CURRENT;
      const current = currentSnapshot?.CURRENT_TASK;
      if (!promoted && !current) {
        setStatus("No context to promote");
        return;
      }
      const target = promoted || current;
      const currentTask = currentSnapshot?.CURRENT_TASK;
      const replaceMsg = currentTask && currentTask !== target ? `\n\nThis will replace current task: "${currentTask}"` : "";
      const msg = `Promote "${target}" to current?${replaceMsg}`;
      if (confirm(msg)) {
        issueCommand("PROMOTE", true, { target, replacesCurrent: currentTask || null });
      }
    } else if (cmdId === "SUPERSEDE") {
      const hasSuperseding = currentSnapshot?.PROMOTED_CURRENT;
      if (!hasSuperseding) {
        setStatus("No prior promotion to supersede");
        return;
      }
      if (confirm(`Supersede "${hasSuperseding}"?\n\nThis will clear the current promoted task.`)) {
        issueCommand("SUPERSEDE", true, { supersedeTarget: hasSuperseding });
      }
    } else {
      issueCommand(cmdId, true);
    }
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
        setStatus(resp?.reason || "Failed to send");
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
  }

  function listenForMessages() {
    browser.runtime.onMessage.addListener((msg, sender) => {
      if (!msg) return;
      if (msg.type === "GCE_SNAPSHOT" && msg.snapshot) {
        handleSnapshot(msg.snapshot);
      } else if (msg.type === "GCE_ACK" && msg.ack) {
        handleAck(msg.ack);
      }
    });
  }

  function init() {
    initElements();
    renderVernacularRow();
    renderSessionTools();
    setupEventListeners();
    listenForMessages();
    setStatus("Ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();