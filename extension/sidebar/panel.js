"use strict";

(function() {
  const DEFAULT_SEAT = "CODA";

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
    el.dlWhat = document.getElementById("dl-what");
    el.dlNext = document.getElementById("dl-next");
    el.sessionTools = document.getElementById("session-tools");
    el.toolsGrid = document.getElementById("tools-grid");
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
    el.btnParkShelf = document.getElementById("btn-park-shelf");
    el.endDlg = document.getElementById("end-dlg");
    el.endSummary = document.getElementById("end-summary");
    el.btnEndClose = document.getElementById("btn-end-close");
    el.btnEndCancel = document.getElementById("btn-end-cancel");
    el.btnEndConfirm = document.getElementById("btn-end-confirm");
    el.ftr = document.getElementById("ftr");
  }

  function fmtFreshness(val) {
    if (!val) return "UNKNOWN";
    return val.toUpperCase();
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

    const blockers = s.BLOCKERS;
    const blockerNum = parseInt(blockers, 10);
    if (blockers && (blockerNum > 0 || typeof blockers === "string")) {
      el.tsBlocker.classList.remove("hidden");
      el.tsBlockerVal.textContent = typeof blockers === "string" ? blockers : blockerNum;
    } else {
      el.tsBlocker.classList.add("hidden");
    }

    const parked = s.PARKED;
    const parkedNum = parseInt(parked, 10);
    if (parked && (parkedNum > 0 || typeof parked === "string")) {
      el.tsParked.classList.remove("hidden");
      el.tsParkedVal.textContent = typeof parked === "string" ? parked : parkedNum;
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

  function renderDonTable(snapshot) {
    const s = snapshot || {};
    renderDlSection(el.dlWhere, [
      ["Session", s.SESSION_ID || "—"],
      ["Status", s.SESSION_STATUS || "—"],
      ["Project", s.PROJECT || "—"],
      ["Workstream", s.WORKSTREAM || "—"]
    ]);
    renderDlSection(el.dlWhat, [
      ["Objective", s.OBJECTIVE || "—"],
      ["Current Task", s.CURRENT_TASK || "—"],
      ["Don Intent", s.DON_INTENT || "—"],
      ["Confidence", s.CONFIDENCE ? s.CONFIDENCE + "%" : "—"],
      ["Checkpoint", s.CHECKPOINT || "—"],
      ["Current Branch", s.CURRENT_BRANCH || "—"],
      ["Origin Anchor", s.ORIGINATING_ANCHOR || "—"],
      ["Current Anchor", s.CURRENT_ANCHOR || "—"],
      ["Promoted", s.PROMOTED_CURRENT || "—"]
    ]);
    renderDlSection(el.dlNext, [
      ["Next Action", s.NEXT_ACTION || "—"],
      ["Next Route", s.NEXT_ROUTE || "—"],
      ["Blocker Route", s.BLOCKER_ROUTE || "—"],
      ["Handoff State", s.HANDOFF_STATE || "—"],
      ["Blockers", s.BLOCKERS || "—"],
      ["Parked", s.PARKED || "—"],
      ["State Freshness", s.STATE_FRESHNESS || "—"],
      ["State As Of", s.STATE_AS_OF || "—"]
    ]);
  }

  function renderDlSection(container, pairs) {
    container.innerHTML = "";
    for (const [dt, dd] of pairs) {
      const d = document.createElement("dt");
      d.textContent = dt;
      const ddEl = document.createElement("dd");
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
    el.btnExpand.querySelector(".toggle-icon").textContent = expansionState ? "▾" : "▸";
    el.btnExpand.querySelector(".toggle-label").textContent = expansionState ? "Hide Details" : "View Details";
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
    el.btnParkShelf.addEventListener("click", openParkDialog);
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
      el.btnExpand.querySelector(".toggle-icon").textContent = "▾";
      el.btnExpand.querySelector(".toggle-label").textContent = "Hide Details";
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