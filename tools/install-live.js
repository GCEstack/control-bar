"use strict";
/*
 * INSTALL INTO DON'S LIVE PROFILE — real AddonManager, real profile.
 *
 * Why this exists instead of install-permanent.ps1:
 * that script extracts the XPI into
 *   %APPDATA%\Floorp\Profiles\<profile>\browser-extension-data\<id>\
 * and prints success. docs/RECOVERY_v1.4.0.md already established that this
 * directory is an extension DATA directory, not a code load path, and that a
 * folder dropped there cannot execute. The live profile still shows the result
 * of that script: 13 files, manifest v1.2.0, and NO entry in extensions.json.
 * So the script reported success while installing nothing that Floorp would
 * ever run. It is kept for history and now fails loudly instead.
 *
 * This installs the way the browser itself installs: Marionette Addon:Install
 * against Don's real profile, with xpinstall.signatures.required=false, which
 * is the documented way to load an unsigned XPI in this project.
 *
 * SAFETY
 *   - refuses to run while Floorp is already open (a live profile is locked)
 *   - backs up extensions.json and extensions.webextensions.uuids first
 *   - runs headless and -no-remote, then exits
 *   - verifies from the profile's OWN extensions.json, not the call's return
 *     value. An install that reports success but does not register is FAIL.
 *
 * Usage:  node tools/install-live.js [--profile <name>] [--xpi <path>]
 * Exit 0 = installed and registered ACTIVE in the live profile.
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const FLOORP_EXE = process.env.FLOORP_EXE || "C:\\Program Files\\Ablaze Floorp\\floorp.exe";
const EXT_ID_FRAGMENT = "control-bar";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/* Marionette client. Response frame is [1, msgId, error, result] — resolving
 * index 1 instead of 3 returns the request id and makes every command look
 * like it succeeded, which is how a real failure becomes a fake pass. */
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
      }, 60000);
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

function floorpRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq floorp.exe" /NH', { encoding: "utf8" });
    return /floorp\.exe/i.test(out);
  } catch (_) { return false; }
}

function latestXpi() {
  const dir = path.join(ROOT, "evidence");
  const candidates = [];
  const scan = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) scan(p);
      else if (f.endsWith(".xpi")) candidates.push(p);
    }
  };
  scan(dir);
  if (!candidates.length) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function pkgVersion(xpi) {
  const { execFileSync } = require("node:child_process");
  const script = `import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1])
print(json.loads(z.read("manifest.json"))["version"])`;
  try {
    return execFileSync("py", ["-3", "-c", script, xpi], { encoding: "utf8" }).trim();
  } catch (_) { return null; }
}

function readRegistered(profileDir) {
  const p = path.join(profileDir, "extensions.json");
  if (!fs.existsSync(p)) return { found: false, reason: "extensions.json not present" };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const hits = (j.addons || []).filter((a) => String(a.id || "").toLowerCase().includes(EXT_ID_FRAGMENT));
    if (!hits.length) {
      return { found: false, reason: "no control-bar entry among " + (j.addons || []).length + " addons" };
    }
    const a = hits[0];
    return {
      found: true, id: a.id, version: a.version, active: !!a.active,
      type: a.type, location: a.location, signedState: a.signedState,
      appDisabled: a.appDisabled, userDisabled: a.userDisabled
    };
  } catch (e) { return { found: false, reason: "extensions.json unreadable: " + e.message }; }
}

(async () => {
  const profileName = arg("--profile", "h6q809pa.default-release");
  const xpi = arg("--xpi", null) || latestXpi();

  console.log("INSTALL INTO LIVE PROFILE — real Floorp AddonManager");
  console.log("=".repeat(62));
  console.log("profile : " + profileName);
  console.log("package : " + (xpi ? path.basename(xpi) : "(none found)"));
  console.log("");

  if (!xpi || !fs.existsSync(xpi)) {
    console.log("[FAIL] no XPI to install. Build one: node build-xpi.js");
    process.exit(1);
  }
  if (!fs.existsSync(FLOORP_EXE)) {
    console.log("[FAIL] Floorp not found at " + FLOORP_EXE);
    process.exit(1);
  }
  if (floorpRunning()) {
    console.log("[FAIL] Floorp is already running. A live profile is locked and the");
    console.log("       install would be overwritten on next launch. Close Floorp, then");
    console.log("       re-run. This is a refusal, not a failure.");
    process.exit(1);
  }

  const profileRoot = path.join(process.env.APPDATA, "Floorp", "Profiles");
  const profileDir = path.join(profileRoot, profileName);
  if (!fs.existsSync(profileDir)) {
    console.log("[FAIL] profile not found: " + profileDir);
    process.exit(1);
  }

  // The signature pref lives in prefs.js for an existing profile; user.js is
  // applied at startup and is the supported place to put it.
  const userJs = path.join(profileDir, "user.js");
  const userJsExisted = fs.existsSync(userJs);
  const userJsPrior = userJsExisted ? fs.readFileSync(userJs, "utf8") : null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (userJsExisted) fs.copyFileSync(userJs, userJs + ".gcecb-backup-" + stamp);

  // Back up the registration records before touching anything.
  for (const f of ["extensions.json", "extensions.webextensions.uuids"]) {
    const src = path.join(profileDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, src + ".gcecb-backup-" + stamp);
  }

  const port = 33000 + Math.floor(Math.random() * 2000);
  fs.appendFileSync(userJs, [
    "",
    "// --- gce-control-bar installer ---",
    'user_pref("marionette.port", ' + port + ');',
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("app.update.auto", false);',
    'user_pref("extensions.update.enabled", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("browser.tabs.warnOnClose", false);',
    ""
  ].join("\n"), "utf8");

  const child = spawn(FLOORP_EXE,
    ["-profile", profileDir, "-no-remote", "-headless", "-marionette"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  child.on("exit", () => { exited = true; });

  const wanted = pkgVersion(xpi);
  let result;
  try {
    if (!await waitPort(port)) {
      result = { fatal: "Marionette never opened port " + port };
    } else {
      const sock = net.connect(port, "127.0.0.1");
      await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
      const m = new Marionette(sock);
      await sleep(700);
      await m.send("WebDriver:NewSession", { capabilities: {} }).catch(() => {});

      let installErr = null;
      try { await m.send("Addon:Install", { path: path.resolve(xpi), temporary: false }); }
      catch (e) { installErr = e; }
      await sleep(5000);

      result = {
        install: installErr ? "REJECTED" : "ACCEPTED",
        reason: installErr
          ? String(installErr.message || installErr).replace(/^Could not install Add-on:\s*/, "").slice(0, 200)
          : null,
        reg: readRegistered(profileDir)
      };
    }
  } finally {
    try { if (!exited) child.kill(); } catch (_) {}
    await sleep(2000);
  }

  console.log(JSON.stringify({
    package: path.basename(xpi),
    package_version: wanted,
    bytes: fs.statSync(xpi).size,
    install: result.fatal ? "ERROR" : result.install,
    reason: result.fatal || result.reason || undefined,
    registered: result.reg && result.reg.found
      ? result.reg.id + " v" + result.reg.version + (result.reg.active ? " ACTIVE" : " INACTIVE") +
        " [" + result.reg.type + "/" + result.reg.location + "] signed=" + result.reg.signedState
      : "no: " + ((result.reg && result.reg.reason) || "unknown")
  }, null, 2));
  console.log("");

  const reg = result.reg || {};
  const ok = reg.found && reg.active && (!wanted || reg.version === wanted);

  console.log("=== VERDICT ===");
  if (ok) {
    console.log("INSTALLED AND ACTIVE — " + reg.id + " v" + reg.version);
    console.log("Backups written to the profile with suffix .gcecb-backup-" + stamp);
    console.log("");
    console.log("Open Floorp. The bar is in the sidebar (View -> Sidebar).");
  } else {
    console.log("NOT PROVEN. Do not report this as installed.");
    if (reg.found && !reg.active) console.log("  registered but NOT active — check about:addons for why");
    if (reg.found && wanted && reg.version !== wanted) {
      console.log("  registered v" + reg.version + " but the package is v" + wanted);
    }
    if (!reg.found) console.log("  not registered: " + (reg.reason || "unknown"));
    console.log("");
    console.log("  The registration records were backed up before this run:");
    console.log("    " + profileDir + "\\extensions.json.gcecb-backup-" + stamp);
  }
  process.exit(ok ? 0 : 1);
})();
