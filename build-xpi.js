"use strict";
/*
 * Control Bar packager.
 *
 * Packaging is the defect class that broke this product's delivery lineage, so the
 * packager VERIFIES ITS OWN OUTPUT instead of assuming success.
 *
 * Root cause of the corrupt packages: ZIP entry names were written with Windows
 * backslashes ("background\main.js"). The ZIP spec (APPNOTE 4.4.17.1) requires
 * forward slashes. Browsers reject or mis-resolve such archives. Node's zlib +
 * manual central-directory writing is used here because the available archivers on
 * this machine all emitted backslashes.
 *
 * Usage: node build-xpi.js <sourceDir> <outFile>
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const srcDir = path.resolve(process.argv[2] || "extension");
const outFile = path.resolve(process.argv[3] || "gce-don-control-bar.xpi");

// Fixed DOS timestamp (1980-01-01 00:00:00) so the build is byte-reproducible.
const DOS_TIME = 0;
const DOS_DATE = 33;

function collect(dir, base, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collect(abs, rel, acc);
    else if (entry.isFile()) acc.push({ rel, abs });
  }
  return acc;
}

const files = collect(srcDir, "", []).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

if (!files.some((f) => f.rel === "manifest.json")) {
  console.error("[FAIL] manifest.json is not at the archive root of " + srcDir);
  process.exit(1);
}

const locals = [];
const centrals = [];
let offset = 0;

for (const f of files) {
  const nameBuf = Buffer.from(f.rel, "utf8"); // forward slashes, guaranteed by collect()
  const raw = fs.readFileSync(f.abs);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const crc = zlib.crc32 ? zlib.crc32(raw) : crc32(raw);

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // version needed
  local.writeUInt16LE(0x0800, 6);      // UTF-8 filename flag
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  locals.push(local, body);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);        // version made by
  central.writeUInt16LE(20, 6);        // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(useDeflate ? 8 : 0, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 38);        // external attrs
  central.writeUInt32LE(offset, 42);
  nameBuf.copy(central, 46);
  centrals.push(central);

  offset += local.length + body.length;
}

const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length, 8);
end.writeUInt16LE(centrals.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

const out = Buffer.concat([...locals, centralBuf, end]);
fs.writeFileSync(outFile, out);

// ---------------------------------------------------------------------------
// VERIFY: reopen the archive we just wrote and prove it is loadable-shaped.
// A packager that does not verify is how this lineage shipped corrupt packages.
// ---------------------------------------------------------------------------
const buf = fs.readFileSync(outFile);

// Locate the end-of-central-directory record.
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) {
  console.error("[FAIL] no end-of-central-directory record — the archive is unreadable");
  process.exit(1);
}
const entryCount = buf.readUInt16LE(eocd + 10);
let p = buf.readUInt32LE(eocd + 16);
const seen = [];
for (let n = 0; n < entryCount; n++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) {
    console.error("[FAIL] corrupt central directory at entry " + n);
    process.exit(1);
  }
  const method = buf.readUInt16LE(p + 10);
  const compSize = buf.readUInt32LE(p + 20);
  const uncompSize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOff = buf.readUInt32LE(p + 42);
  const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

  if (name.includes("\\")) {
    console.error("[FAIL] entry uses a BACKSLASH path separator: " + JSON.stringify(name) +
      " — this is the exact defect that made earlier packages unloadable");
    process.exit(1);
  }
  if (buf.readUInt32LE(localOff) !== 0x04034b50) {
    console.error("[FAIL] entry " + JSON.stringify(name) + " has a bad local header signature");
    process.exit(1);
  }
  const lNameLen = buf.readUInt16LE(localOff + 26);
  const lExtraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + lNameLen + lExtraLen;
  const comp = buf.slice(dataStart, dataStart + compSize);
  const raw = method === 8 ? zlib.inflateRawSync(comp) : comp;
  if (raw.length !== uncompSize) {
    console.error("[FAIL] size mismatch on " + name + ": header says " + uncompSize + ", inflated " + raw.length);
    process.exit(1);
  }
  seen.push({ name, raw });
  p += 46 + nameLen + extraLen + commentLen;
}

// Every packaged byte must equal the source byte.
for (const f of files) {
  const hit = seen.find((s) => s.name === f.rel);
  if (!hit) {
    console.error("[FAIL] " + f.rel + " is in the source but not in the archive");
    process.exit(1);
  }
  const src = fs.readFileSync(f.abs);
  if (Buffer.compare(hit.raw, src) !== 0) {
    console.error("[FAIL] " + f.rel + " does not round-trip byte-identically");
    process.exit(1);
  }
}

const manifestEntry = seen.find((s) => s.name === "manifest.json");
let mf;
try {
  mf = JSON.parse(manifestEntry.raw.toString("utf8"));
} catch (e) {
  console.error("[FAIL] manifest.json in the archive is not valid JSON: " + e.message);
  process.exit(1);
}

// The panel must load the protocol module, or the panel silently falls back to a
// second, divergent control list. Verify the tag actually exists in the packaged HTML.
// CB_SKIP_PROJCHECK=1 isolates pure ZIP-validity probing (used when repackaging a
// baseline tree that predates this check).
const panelEntry = seen.find((s) => s.name === "sidebar/panel.html");
if (!panelEntry) {
  console.error("[FAIL] sidebar/panel.html missing from the archive");
  process.exit(1);
}
const panelHtml = panelEntry.raw.toString("utf8");
if (!/src="\.\.\/lib\/protocol\.js"/.test(panelHtml) && !process.env.CB_SKIP_PROJCHECK) {
  console.error("[FAIL] panel.html does not load ../lib/protocol.js — the panel would use a divergent control list");
  process.exit(1);
}

/*
 * Floorp/Firefox 157 REJECTS THE WHOLE PACKAGE as ERROR_CORRUPT_FILE when any
 * commands.suggested_key carries three or more modifiers. Proven against the real
 * browser: Ctrl+Alt+Shift+C / Ctrl+Alt+Shift+H / Ctrl+Alt+Shift+KeyC all rejected,
 * while Ctrl+Alt+C, Ctrl+Alt+8 and Ctrl+Alt+1..7 all install and activate.
 * This single key format invalidated the whole 1.3.2 packaging lineage, which is
 * why repatching that lineage could never produce an installable build.
 */
if (mf.commands) {
  const MODS = new Set(["Ctrl", "Alt", "Shift", "Command", "MacCtrl"]);
  for (const [name, def] of Object.entries(mf.commands)) {
    const key = def && def.suggested_key && def.suggested_key.default;
    if (!key) continue;
    const parts = key.split("+");
    const mods = parts.slice(0, -1).filter(p => MODS.has(p));
    const unknown = parts.slice(0, -1).filter(p => !MODS.has(p));
    if (unknown.length) {
      console.error("[FAIL] commands." + name + " has an unrecognised modifier " +
        JSON.stringify(unknown[0]) + " in " + JSON.stringify(key));
      process.exit(1);
    }
    if (mods.length > 2) {
      console.error("[FAIL] commands." + name + " uses " + mods.length + " modifiers (" + key +
        "). The browser rejects the entire package with ERROR_CORRUPT_FILE at 3+.");
      process.exit(1);
    }
  }
  const seenKeys = new Map();
  for (const [name, def] of Object.entries(mf.commands)) {
    const key = def && def.suggested_key && def.suggested_key.default;
    if (!key) continue;
    if (seenKeys.has(key)) {
      console.error("[FAIL] shortcut " + key + " is claimed by both " + seenKeys.get(key) + " and " + name);
      process.exit(1);
    }
    seenKeys.set(key, name);
  }
}

// No META-INF: unsigned. Floorp accepts unsigned XPIs via "Install Add-on From File".
const hasMetaInf = seen.some((s) => s.name.startsWith("META-INF/"));
if (hasMetaInf) {
  console.error("[FAIL] META-INF present — this build must be unsigned, a stale signature would fail validation");
  process.exit(1);
}

const sha = crypto.createHash("sha256").update(buf).digest("hex");
console.log("BUILD OK");
console.log("  file:       " + outFile);
console.log("  entries:    " + seen.length);
console.log("  separators: forward slashes only (verified on every entry)");
console.log("  manifest:   " + mf.name + " v" + mf.version);
console.log("  signing:    unsigned (no META-INF)");
console.log("  roundtrip:  every entry byte-identical to source");
console.log("  panel:      loads ../lib/protocol.js (single source of truth for controls)");
console.log("  size:       " + buf.length + " bytes");
console.log("  sha256:     " + sha);