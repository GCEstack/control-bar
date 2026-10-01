# STEP-0 HOST FACT CHECK — Floorp WebExtension capability evidence

**Host:** Floorp 12.18.1 (Gecko 156.0.1), buildID on disk 20260923054204
**Binary:** `C:\Users\Dekan AI Brother\AppData\Local\Ablaze Floorp\floorp.exe`
**Profile observed (live):** `AppData\Roaming\Floorp\Profiles\h6q809pa.default-release`
**Date:** 2026-09-26
**Ruling applied:** Don — skip runtime check, build now; Step Zero treated as
satisfied-by-installation-evidence. Runtime proof is recorded here as
**NOT PERFORMED**, not as a pass. See "Ground truth / conflict" below.

## Required capabilities and what was verified

| Capability | Where declared in the installed host | Verdict |
|---|---|---|
| `sidebar_action` | `browser/omni.ja` → `chrome/browser/content/browser/schemas/sidebar_action.json` | PRESENT in host build |
| `commands` | `browser/omni.ja` → `chrome/browser/content/browser/schemas/commands.json` | PRESENT in host build |
| content scripts | `omni.ja` → `chrome/toolkit/content/extensions/schemas/content_scripts.json` | PRESENT in host build |
| `storage.local` | `omni.ja` → `chrome/toolkit/content/extensions/schemas/storage.json` | PRESENT in host build |

Evidence method: direct read of the shipped archive members inside Floorp's own
`omni.ja` / `browser\omni.ja` (System.IO.Compression.ZipFile enumeration). These
are the authoritative manifest/API schema declarations the WebExtension platform
compiles against in this exact build.

## Static enumeration (verbatim, from the installed host)

```
omni.ja  (3647 archive members)
  chrome/toolkit/content/extensions/schemas/content_scripts.json
  chrome/toolkit/content/extensions/schemas/storage.json
  chrome/toolkit/content/extensions/schemas/runtime.json
  (… plus the rest of the toolkit schema set)

browser\omni.ja  (5406 archive members)
  chrome/browser/content/browser/schemas/commands.json
  chrome/browser/content/browser/schemas/sidebar_action.json
```

`manifest.json` for this build parses as valid JSON and its declared API surface
(`sidebar_action`, `commands`, `content_scripts`, `storage` permission) resolves
against schemas that are present in the same install.

## Runtime fact-check attempt — what happened

A disposable probe extension + a throwaway Floorp profile were built
(`Temp\opencode\gce-step0\`) and a Marionette driver was written to install it
temporarily and read back live results. The driver reached the browser and
Marionette listened on the configured port. **The runtime probe was not
completed**: every browser window raised a human-verification challenge in this
environment, and per Don's instruction no further browser windows were opened.
No runtime capability result was obtained.

Because the probe did not complete, the following remain **unverified at
runtime** and are the honest residual risk carried into the build:

- That `sidebarAction.open()` actually renders the panel in this Floorp build.
- That a `Ctrl+Alt+1..7` `commands` shortcut actually dispatches to
  `commands.onCommand` in this Floorp build.
- That the ChatGPT content script's composer selectors match the live ChatGPT DOM
  at the time of use.

These are surface behaviours of the host and of a third-party page, not of the
protocol core. The protocol core (envelope emit, nonce binding, ACK parse, state
cache, lifecycle) is covered headlessly and passes T1–T8 (see
`acceptance-report.json`).

## Ground-truth / spec conflict — SURFACED, NOT RESOLVED

Two real conflicts were found during Step Zero / build and are recorded here
rather than silently absorbed:

1. **Step Zero could not be satisfied as written.** The spec's Step Zero demands
   direct runtime proof in the installed Floorp. That proof was not obtainable in
   this environment (human-verification gate). Per §16 ("if ground truth
   contradicts the frozen specification, surface the conflict"), this is surfaced
   to Don and Coda. The spec was not rewritten to claim a pass; the build was
   authorized to proceed by explicit ruling and the residual risk is documented
   above.

2. **ACK close-tag delimiter (found and FIXED in code, noted for the record).**
   The frozen §8 ACK block is `[GCE-ACK v1] … [/GCE-ACK]` — the version appears
   only on the open tag. The first implementation derived the close tag from the
   version string (`[/GCE-ACK v1]`), which would have rejected every real ACK.
   This is an implementation defect that was corrected to match the spec exactly
   (constants `ACK_OPEN` / `ACK_CLOSE` in `lib/protocol.js`). Flagged because it
   is a protocol-boundary detail that any independent verifier should re-check
   against §8.

## Reproduction commands

Schema presence (host):
```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$za=[System.IO.Compression.ZipFile]::OpenRead("C:\Users\Dekan AI Brother\AppData\Local\Ablaze Floorp\browser\omni.ja")
$za.Entries | ? { $_.FullName -match 'schemas/(sidebar_action|commands)\.json$' } | % FullName
$za.Dispose()
```

Acceptance suite (headless, protocol core):
```powershell
cd "C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar"
node test\run-tests.js
```
