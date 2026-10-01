"use strict";
/*
 * NATIVE INSTALL PROOF — real Floorp, no human in the loop.
 *
 * Why this exists: Don is not the QA environment. The whole 1.3.2 packaging lineage
 * shipped packages that could never load, and every "it builds" signal before this
 * was a self-report. This script asks the browser itself.
 *
 * How it works:
 *   - launches a SEPARATE Floorp with its own throwaway profile and -no-remote,
 *     so Don's running instance is never touched
 *   - installs through Marionette's Addon:Install, which is the browser's own
 *     AddonManager — the same path as about:addons "Install Add-on From File"
 *   - verifies success from the profile's OWN extensions.json, written by the
 *     browser at startup, not from the install call's return value
 *
 * Usage:  node test/native-install-proof.js <package.xpi> [more.xpi ...]
 * Exit 0 = every package installed and registered ACTIVE.
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const FLOORP_EXE = process.env.FLOORP_EXE || "C:\\Program Files\\Ablaze Floorp\\floorp.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Minimal Marionette client.
 * Wire format: "<byteLength>:<json>" frames.
 * Command frame  = [0, msgId, name, params]
 * Response frame = [1, msgId, error, result]   <-- result is index 3.
 * Resolving with index 1 returns the request id and makes every command look like
 * it "succeeded", which is how a real failure can masquerade as a pass. */
class Marionette {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.msgId = 0;
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
        if (this.pending.has(frame[1])) { this.pending.delete(frame[1]); reject(new Error("timeout on " + command)); }
      }, 45000);
    });
  }
}

function waitPort(port, tries = 90) {
  return (async () => {
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
  })();
}

function writeProfile(dir, port) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "user.js"), [
    'user_pref("marionette.port", ' + port + ');',
    // Unsigned XPIs are what this project ships; Floorp honours this pref.
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("app.update.auto", false);',
    'user_pref("extensions.update.enabled", false);',
    'user_pref("browser.tabs.warnOnClose", false);', ''
  ].join("\n"), "utf8");
}

function readRegistered(profileDir) {
  const p = path.join(profileDir, "extensions.json");
  if (!fs.existsSync(p)) return { found: false, reason: "extensions.json not written" };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const hits = (j.addons || []).filter((a) => String(a.id || "").toLowerCase().includes("control-bar"));
    if (!hits.length) return { found: false, reason: "no control-bar entry (" + (j.addons || []).length + " addons total)" };
    const a = hits[0];
    return {
      found: true, id: a.id, version: a.version, active: a.active, type: a.type,
      location: a.location, signedState: a.signedState,
      appDisabled: a.appDisabled, userDisabled: a.userDisabled
    };
  } catch (e) { return { found: false, reason: "extensions.json unreadable: " + e.message }; }
}

async function tryInstall(pkg, profileDir, port) {
  writeProfile(profileDir, port);
  const child = spawn(FLOORP_EXE,
    ["-profile", profileDir, "-no-remote", "-headless", "-marionette"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  child.on("exit", () => { exited = true; });
  try {
    if (!fs.existsSync(FLOORP_EXE)) return { fatal: "Floorp not found at " + FLOORP_EXE };
    if (!await waitPort(port)) return { fatal: "Marionette never opened port " + port };
    const sock = net.connect(port, "127.0.0.1");
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    const m = new Marionette(sock);
    await sleep(500);
    await m.send("WebDriver:NewSession", { capabilities: {} }).catch(() => {});

    let installErr = null;
    try { await m.send("Addon:Install", { path: pkg, temporary: false }); }
    catch (e) { installErr = e; }

    // Give the browser time to register and start the add-on, then read ITS record.
    await sleep(4000);
    const reg = readRegistered(profileDir);
    return {
      install: installErr ? "REJECTED" : "ACCEPTED",
      reason: installErr ? String(installErr.message || installErr).replace(/^Could not install Add-on:\s*/, "").slice(0, 160) : null,
      reg
    };
  } finally {
    try { if (!exited) child.kill(); } catch (_) {}
    await sleep(1200);
  }
}

(async () => {
  const pkgs = process.argv.slice(2).map((p) => path.resolve(p));
  if (!pkgs.length) { console.error("usage: node test/native-install-proof.js <package.xpi> [...]"); process.exit(2); }

  console.log("NATIVE INSTALL PROOF — real Floorp, throwaway profile, -no-remote, headless");
  console.log("browser: " + FLOORP_EXE + "\n");

  const tmpRoot = path.join(os.tmpdir(), "gce-control-bar-install-proof");
  const results = [];
  let port = 31000 + Math.floor(Math.random() * 2000);

  for (const pkg of pkgs) {
    if (!fs.existsSync(pkg)) { console.log("MISSING  " + pkg + "\n"); continue; }
    const r = await tryInstall(pkg, path.join(tmpRoot, "profile-" + port), port);
    port++;
    const ok = r.reg && r.reg.found && r.reg.active;
    const row = {
      package: path.basename(pkg),
      bytes: fs.statSync(pkg).size,
      install: r.fatal ? "ERROR" : r.install,
      reason: r.fatal || r.reason || undefined,
      registered: r.reg && r.reg.found
        ? r.reg.id + " v" + r.reg.version + (r.reg.active ? " ACTIVE" : " inactive") +
          " [" + r.reg.type + "/" + r.reg.location + "] signed=" + r.reg.signedState
        : "no: " + ((r.reg && r.reg.reason) || "unknown"),
      verdict: ok ? "NATIVE INSTALL PROVEN" : "NOT PROVEN"
    };
    results.push({ name: row.package, ok });
    console.log(JSON.stringify(row, null, 2));
    console.log("");
  }

  console.log("=== SUMMARY ===");
  for (const s of results) console.log((s.ok ? "PASS  " : "FAIL  ") + s.name);
  const allOk = results.length > 0 && results.every((s) => s.ok);
  console.log(allOk ? "\nALL PACKAGES INSTALL AND ACTIVATE." : "\nONE OR MORE PACKAGES DID NOT INSTALL.");
  process.exit(allOk ? 0 : 1);
})();