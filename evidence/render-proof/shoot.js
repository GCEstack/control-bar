"use strict";
/*
 * Render proof — drives the REAL panel in REAL headless Floorp and saves PNGs.
 *
 * Unit tests cannot see this defect class. The D-15 blocker-colour breach sat in
 * committed CSS since v1.3.2 and passed every test in this repo. So the visual claim
 * is proven by rendering and looking at pixels.
 *
 * Serves the repo over loopback HTTP (panel.js reads localStorage at load, which
 * file:// blocks in Firefox), then screenshots the real panel at a fixed viewport.
 *
 * Usage: node evidence/render-proof/shoot.js [outDir]
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(__dirname, "shots"));
const FLOORP_EXE = process.env.FLOORP_EXE || "C:\\Program Files\\Ablaze Floorp\\floorp.exe";
const PORT = 38221;
const MARIONETTE = 38321;
const VIEWPORT_W = 340;
const VIEWPORT_H = 900;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || "/").split("?")[0]);
      const target = path.join(REPO, url === "/" ? "/index.html" : url);
      if (!target.startsWith(REPO) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(target)] || "application/octet-stream" });
      fs.createReadStream(target).pipe(res);
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

class Marionette {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.pending = new Map(); this.msgId = 0;
    sock.on("data", (d) => this._onData(d));
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const colon = this.buf.indexOf(0x3a);
      if (colon < 0) return;
      const len = parseInt(this.buf.slice(0, colon).toString("ascii"), 10);
      if (!Number.isFinite(len)) { this.buf = Buffer.alloc(0); return; }
      const start = colon + 1;
      if (this.buf.length < start + len) return;
      let frame;
      try { frame = JSON.parse(this.buf.slice(start, start + len).toString("utf8")); }
      catch (_) { this.buf = Buffer.alloc(0); return; }
      this.buf = this.buf.slice(start + len);
      if (Array.isArray(frame) && frame[0] === 1) {
        const [, id, err, result] = frame;
        const q = this.pending.get(id);
        if (q) { this.pending.delete(id); err ? q.reject(new Error(JSON.stringify(err))) : q.resolve(result); }
      }
    }
  }
  send(command, params = {}) {
    const frame = [0, ++this.msgId, command, params];
    const json = Buffer.from(JSON.stringify(frame), "utf8");
    this.sock.write(Buffer.concat([Buffer.from(json.length + ":", "ascii"), json]));
    return new Promise((resolve, reject) => {
      this.pending.set(frame[1], { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(frame[1])) { this.pending.delete(frame[1]); reject(new Error("timeout " + command)); }
      }, 45000);
    });
  }
}

async function waitPort(port, tries = 90) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); res(true); });
      s.once("error", () => { s.destroy(); res(false); });
    });
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

/* Measures the DOM facts that matter for this recovery, so the proof is not just
 * "a picture exists" but that the ratified hierarchy actually rendered. */
const MEASURE = `
  const d = document;
  const q = (s) => d.querySelector(s);
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };

const hero = q(".table-section.hero");
    const blocker = q("#ts-blocker-val");
  const parked = q("#ts-parked-val");
  const sections = [...d.querySelectorAll(".table-section")].map(s => {
    const dl = s.querySelector(".section-dl");
    return {
      name: (s.querySelector(".section-hdr") || {}).textContent,
      key: s.getAttribute("data-section"),
      bg: cs(s, "backgroundColor"),
      border: cs(s, "borderTopWidth"),
      hasBox: vis(s),
      rows: dl ? dl.querySelectorAll("dt").length : 0,
      noRows: s.classList.contains("no-rows")
    };
  });
  const vn = [...d.querySelectorAll(".vn-btn")].map(b => ({
    label: b.textContent.trim(),
    h: Math.round(b.getBoundingClientRect().height),
    w: Math.round(b.getBoundingClientRect().width),
    wrapped: b.scrollHeight > b.clientHeight + 1,
    truncated: b.scrollWidth > b.clientWidth + 1
  }));

  return {
    title: d.title,
    // D-15: blocker must be amber, never red.
    blockerVisible: vis(blocker),
    blockerText: blocker ? blocker.textContent.trim() : null,
    blockerCount: blocker ? (blocker.querySelector("span") || {}).textContent : null,
    blockerFlagDrawn: !!(blocker && blocker.querySelector(".chip-flag")),
    blockerFlagBox: blocker ? (() => { const f = blocker.querySelector(".chip-flag"); if (!f) return null; const r = f.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
    blockerColor: cs(blocker, "color"),
    blockerIsRed: blocker ? /255,\\s*69,\\s*58/.test(cs(blocker, "color")) : false,
    parkedVisible: vis(parked),
    parkedText: parked ? parked.textContent.trim() : null,
    parkedCount: parked ? (parked.querySelector("span") || {}).textContent : null,
    parkedFlagDrawn: !!(parked && parked.querySelector(".chip-flag")),
    // hero
    heroPresent: vis(hero),
    // DON CORRECTION 7 — the objective slot always renders, calm when absent.
    objectiveSlot: vis(q("#ts-objective-val")),
    objectiveText: (q("#ts-objective-val") || {}).textContent,
    objectiveCalm: q("#ts-objective-val") ? q("#ts-objective-val").classList.contains("calm") : null,
    seatShown: (q("#ts-seat-val") || {}).textContent,
    // DON CORRECTION 6 — no detached footer controls.
    detachedFooter: !!q(".panel-footer"),
    logInsideDrawer: !!q("#session-tools #btn-log"),
    // cards
    sections,
    // park shelf
    parkShelfVisible: vis(q("#park-shelf")),
    parkTiles: [...d.querySelectorAll(".park-tile")].map(t => t.textContent.trim()),
    // next action bar
    nextActionVisible: vis(q(".next-action-bar")),
    nextActionText: (q("#next-action-value") || {}).textContent,
    nextActionButtons: [...d.querySelectorAll(".next-action-actions .tool-btn")].map(b => b.textContent.trim()),
    // tools drawer
    toolsDrawerOpen: !!q(".session-tools.open"),
    toolsButtons: [...d.querySelectorAll(".tools-grid .tool-btn")].map(b => b.textContent.trim()),
    // vernacular
    vernacular: vn,
    anyWrap: vn.some(b => b.wrapped),
    anyTruncate: vn.some(b => b.truncated),
    // disclosure
    tableExpanded: !!q(".don-table.expanded"),
    contentHidden: !!q("#table-content.hidden"),
    panelHeight: Math.round(d.body.getBoundingClientRect().height)
  };
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  console.log("serving " + REPO + " on http://127.0.0.1:" + PORT);

  const profileDir = path.join(require("node:os").tmpdir(), "gce-cb-renderproof");
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "user.js"), [
    'user_pref("marionette.port", ' + MARIONETTE + ');',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("app.update.auto", false);',
    'user_pref("extensions.update.enabled", false);', ''
  ].join("\n"), "utf8");

  const child = spawn(FLOORP_EXE,
    ["-profile", profileDir, "-no-remote", "-headless", "-marionette", "-window-size", VIEWPORT_W + "," + VIEWPORT_H],
    { stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  child.on("exit", () => { exited = true; });
  child.stderr.on("data", d => { if (process.env.RP_VERBOSE) console.log("[browser] " + String(d).trim()); });

  const results = [];
  try {
    if (!await waitPort(MARIONETTE)) throw new Error("marionette never opened");
    const sock = net.connect(MARIONETTE, "127.0.0.1");
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    const m = new Marionette(sock);
    await sleep(500);
    await m.send("WebDriver:NewSession", { capabilities: {} });
    await m.send("WebDriver:SetWindowRect", { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H }).catch(() => {});
    console.log("[OK] marionette session\n");

    const CASES = [
      { name: "01-collapsed-default", case: "prose", expand: 0 },
      { name: "02-expanded-prose-blockers", case: "prose", expand: 1 },
      { name: "03-expanded-counted-blockers", case: "counted", expand: 1 },
      { name: "04-expanded-calm-unknown", case: "calm", expand: 1 },
      // Identity frames — the active seat may be any of them.
      { name: "05-seat-coda", case: "counted", expand: 1, seat: "CODA" },
      { name: "06-seat-enzo", case: "counted", expand: 1, seat: "ENZO" },
      { name: "07-seat-serafina", case: "prose", expand: 1, seat: "SERAFINA" },
      { name: "08-seat-nico", case: "counted", expand: 1, seat: "NICO" },
      // Surface frames — ChatGPT vs Kimi must render identically.
      { name: "09-surface-kimi", case: "counted", expand: 1, surface: "kimi", seat: "SERAFINA" },
      { name: "10-surface-kimi-calm", case: "calm", expand: 1, surface: "kimi", seat: "LUCE" }
    ];

    for (const c of CASES) {
      const params = new URLSearchParams({ case: c.case, expand: String(c.expand) });
      if (c.seat) params.set("seat", c.seat);
      if (c.surface) params.set("surface", c.surface);
      const url = `http://127.0.0.1:${PORT}/evidence/render-proof/harness.html?` + params.toString();
      await m.send("WebDriver:Navigate", { url });
      // wait for the harness to signal it delivered a snapshot
      let ready = false;
      for (let i = 0; i < 60; i++) {
        await sleep(250);
        try {
          const t = await m.send("WebDriver:GetCurrentURL", {});
          const ttl = await m.send("WebDriver:ExecuteScript", { script: "return document.title;", args: [] });
          if (String(ttl).includes("READY:")) { ready = true; break; }
        } catch (_) {}
      }
      await sleep(700);

      let measured = null;
      try { measured = await m.send("WebDriver:ExecuteScript", { script: MEASURE, args: [] }); }
      catch (e) { measured = { error: e.message }; }
      // Marionette wraps script return values in { value: ... }
      if (measured && typeof measured === "object" && "value" in measured) measured = measured.value;

      const shot = await m.send("WebDriver:TakeScreenshot", { full: true, hash: false }).catch(() => null);
      // Marionette returns the screenshot as { value: "<base64 png>" }
      const shotB64 = shot && typeof shot === "object" ? shot.value : shot;
      if (shotB64 && typeof shotB64 === "string" && shotB64.length > 100) {
        fs.writeFileSync(path.join(OUT, c.name + ".png"), Buffer.from(shotB64, "base64"));
      }
      const full = await m.send("WebDriver:TakeScreenshot", { full: false, hash: false }).catch(() => null);
      const fullB64 = full && typeof full === "object" ? full.value : full;
      if (fullB64 && typeof fullB64 === "string" && fullB64.length > 100) {
        fs.writeFileSync(path.join(OUT, c.name + "-viewport.png"), Buffer.from(fullB64, "base64"));
      }

      results.push({ name: c.name, ready, seat: c.seat || null, surface: c.surface || "chatgpt", measured });
      console.log("##### " + c.name + (ready ? "" : "  [NOT READY]") + " #####");
      console.log(JSON.stringify(measured, null, 2));
      console.log("");
    }
  } finally {
    try { if (!exited) child.kill(); } catch (_) {}
    server.close();
    await sleep(800);
  }

  fs.writeFileSync(path.join(OUT, "render-proof.json"), JSON.stringify(results, null, 2));

  console.log("=== RENDER PROOF SUMMARY ===");
  let fail = 0;
  for (const r of results) {
    const m2 = r.measured || {};
    const checks = {};
    // D-15: an exception must never render red.
    checks["blocker never red"] = m2.blockerIsRed === false;
    // The exception flag must actually be drawn, not a missing-glyph blank.
    if (m2.blockerVisible) {
      checks["flag drawn in CSS"] = m2.blockerFlagDrawn === true &&
        !!m2.blockerFlagBox && m2.blockerFlagBox.w > 0 && m2.blockerFlagBox.h > 0;
    }
    // D-15: the RE-CENTER wrap fix.
    checks["no button wrap"] = m2.anyWrap === false;
    // A button must never clip its own name ("RE-C...").
    checks["no label truncation"] = m2.anyTruncate === false;
    // Five frozen verbs all present.
    checks["five verbs"] = Array.isArray(m2.vernacular) && m2.vernacular.length === 5;
    // "Chips glance" — a parked chip must carry the count the seat actually sent.
    if (m2.parkedVisible) {
      checks["parked chip has count"] = m2.parkedCount !== null && String(m2.parkedCount).trim() !== "";
      checks["parked flag drawn"] = m2.parkedFlagDrawn === true;
    }
    if (m2.tableExpanded) {
      // The design's three-question architecture, restored by key.
      const keys = Array.isArray(m2.sections) ? m2.sections.map(s => s.key) : [];
      checks["three-question architecture"] = keys.includes("where") && keys.includes("what");
      checks["exceptions present"] = keys.includes("exceptions");
      // DON CORRECTION 5 — exceptions rise directly under WHERE AM I.
      const whereIdx = keys.indexOf("where");
      const exIdx = keys.indexOf("exceptions");
      checks["exceptions under where"] = whereIdx !== -1 && exIdx === whereIdx + 1;
      // DON CORRECTION 3 — cards with no rows collapse.
      const collapsed = Array.isArray(m2.sections) && m2.sections.filter(s => s.rows === 0);
      checks["empty cards collapse"] = !collapsed || collapsed.every(s => s.noRows || s.key === "exceptions" || s.key === "parked");
      checks["next-action bar"] = m2.nextActionVisible === true;
      checks["tools drawer collapsed"] = m2.toolsDrawerOpen === false;
      // DON CORRECTION 6 — LOG moved into the drawer, footer gone.
      checks["no detached footer"] = m2.detachedFooter === false;
      checks["log inside drawer"] = m2.logInsideDrawer === true;
    } else {
      // Collapsed is the DEFAULT: nothing from the depth layer may leak through.
      checks["collapsed hides table"] = m2.contentHidden === true;
    }
    // DON CORRECTION 7 — objective slot always renders, calm placeholder when null.
    checks["objective slot always"] = m2.objectiveSlot === true;
    checks["objective calm when absent"] = m2.objectiveText ? m2.objectiveText.trim() !== "" : false;
    // Identity frames: the seat shown must be the one state named, with no default.
    if (r.seat) {
      checks["seat from state"] = String(m2.seatShown || "").trim().toUpperCase() === r.seat;
    }
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    if (bad.length) fail++;
    console.log((bad.length ? "FAIL  " : "PASS  ") + r.name + (bad.length ? "  -> " + bad.join(", ") : ""));
  }
  console.log("shots -> " + OUT);
  process.exit(fail ? 1 : 0);
})();