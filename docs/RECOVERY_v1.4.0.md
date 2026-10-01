# RECOVERY RECORD — Control Bar recovery forward from the known-good product

**SEAT:** Nico (Implementation Design / Build)
**BRANCH:** `recovery/from-known-good-v1.2.0` (forked from `5961342`)
**BUILT:** 2026-09-30
**STATUS OF THIS DOCUMENT:** build evidence. **NOT** an independent verification.
Nico does not verify Nico. Verification gate = **Luce**.

---

## 1. The delivery baseline (proved, not inferred)

The last artifact Don actually had on disk in the live Floorp profile:

| Property | Value |
|---|---|
| Artifact | `gce-don-control-bar-1.2.0.xpi` |
| Version | 1.2.0 |
| Size | 30103 bytes |
| SHA-256 | `84A4B061E645A3AF…` (first 16; full value in the build log) |
| Source commit | `5961342` — "Initial commit: Control Bar v1.2.0" |
| Build method | `Compress-Archive` (Windows PowerShell 5.1) → `.zip` → renamed `.xpi` |
| Signing | unsigned, no `META-INF` |
| Install method | `install-permanent.ps1` → `%APPDATA%\Floorp\Profiles\h6q809pa.default-release\browser-extension-data\gce-don-control-bar@don.local` |
| Extension id | `gce-don-control-bar@don.local` |

**Proof it is the real baseline, two independent ways:**

1. **Byte identity.** All 12 files of the installed tree are byte-identical to
   `git show 5961342:extension/…` — 12/12 (verified per-file by SHA-256 and by
   git blob hash). Commits `314ccb1` / `92640da` differ only in `manifest.json`
   (11/12); `abc7623` differs in 5 files; `f57cae5` in 6.
2. **Native install.** `gce-don-control-bar-1.2.0.xpi` installs into a real Floorp
   157 through the browser's own AddonManager and registers **ACTIVE**
   (`extension/app-profile`, signed=0). See `test/native-install-proof.js`.

### Ground-truth conflict, surfaced not resolved

The order's premise was "the Control Bar was already a WORKING PRODUCT that Don
installed and used". Half of that is not supported by machine evidence:

- The extension was **never registered with Floorp** in any profile. No entry in
  any `extensions.json`; no UUID in `extensions.webextensions.uuids` (checked
  profiles `h6q809pa.default-release` and `sq90kypl.default-release-1`).
- `browser-extension-data/<id>/` is an extension **data** directory, not a code
  load path. A folder dropped there cannot execute.
- The builder's own `docs/BUILD_RETURN.md` (2026-09-26) already recorded
  `HOST RUNTIME (Step Zero) . PARTIAL (… live browser proof NOT obtained)`.

So v1.2.0 is a **proven-installable baseline** (proved now, by machine) but was
**never a proven-running product**. That distinction is reported, not silently
repaired. `[CONFLICT — governance decision]`

---

## 2. Why every 1.3.2 package was dead on arrival

Root cause, isolated by bisection against the real browser:

> **Floorp/Firefox 157 rejects the ENTIRE package with `ERROR_CORRUPT_FILE` when
> any `commands.suggested_key` carries three or more modifiers.**

Measured on the real browser:

| suggested_key | modifiers | result |
|---|---|---|
| `Ctrl+Alt+1` … `Ctrl+Alt+7` (baseline) | 2 | installs, ACTIVE |
| `Ctrl+Alt+8` | 2 | installs, ACTIVE |
| `Ctrl+Alt+C` | 2 | installs, ACTIVE |
| `Ctrl+Alt+Shift+C` | 3 | **REJECTED** `ERROR_CORRUPT_FILE` |
| `Ctrl+Alt+Shift+H` | 3 | **REJECTED** |
| `Ctrl+Alt+Shift+KeyC` | 3 | **REJECTED** |

Every vernacular command in the 1.3.2 lineage was bound to `Ctrl+Alt+Shift+*`.
The manifest was therefore uninstallable by construction. **No amount of
repacking or repatching that lineage could ever produce a loadable build** — which
is exactly what the recovery order suspected.

**Packaging was exonerated.** `build-xpi.js` repacked the *unmodified* baseline
tree and that package installed and activated natively, so the packager is sound.
(The earlier backslash-vs-forward-slash theory is **wrong**: Floorp accepted
backslash entry names in the baseline. Both are tolerated. The manifest was the
defect all along.)

**Permanent guard added** in `build-xpi.js`: the build now fails on ≥3 modifiers,
unrecognised modifiers, duplicate shortcuts, a `manifest.json` not at the archive
root, any backslash entry, a `META-INF` signature, an entry that does not
round-trip byte-identically, and a `panel.html` that does not load
`../lib/protocol.js`.

---

## 3. Delta inventory: known-good → intended 1.3.2

| Feature | Classification | Disposition |
|---|---|---|
| Full Control Bar surface (vernacular row + Session Tools) | PRESERVE | applied |
| Don vernacular (CAPISCE/HOLD/BRANCH/RE-CENTER/PARK) | PRESERVE | applied, **shortcuts changed** (§4) |
| Session Tools drawer | PRESERVE | applied |
| State/trust strip | PRESERVE | applied |
| PARK + Park Shelf | PRESERVE | applied |
| HOLD + Release Hold latch | PRESERVE | applied |
| BRANCH payload | PRESERVE | applied |
| PROMOTE / SUPERSEDE | PRESERVE | applied, moved to `Ctrl+Alt+8/9` |
| Snapshot normalisation (`normalizeSnapshot`) | ALREADY PRESENT | verified correct, kept |
| `PARKED_ITEMS` JSON→array coercion | ALREADY PRESENT | verified correct, kept |
| Payload governance (allowlist / schema / 8KB ceiling) | ALREADY PRESENT | verified, kept |
| ACK rejection states + truncated-ACK logging | PRESERVE | applied |
| Transport/framework separation | PRESERVE | preserved, probed (R8) |
| Injection protection (Park Shelf rows) | ALREADY PRESENT | uses `createElement`+`textContent` |
| `Ctrl+Alt+1..7` contract | **REQUIRES ADAPTATION** | restored (§4) |
| `panel.html` loading `protocol.js` | **REQUIRES ADAPTATION** | **fixed** (§5) |
| End-dialog `innerHTML` sink | **REQUIRES ADAPTATION** | **fixed** (§6) |
| 1.3.2 packaging artifacts (`-fixed`, `-fresh`, `-py`, `-sidebar-only`, `-verify`) | **DO NOT CARRY FORWARD** | excluded from the branch |

### `[CONFLICT — not resolved here]` R8: "Zero GCE semantics"

`test/regression-probes.js` R8 fails on the recovery build. It flags conditional
logic on GCE vocabulary (`AUTHORITY`, `OBJECTIVE`, `CURRENT_TASK`, `BLOCKERS`, …)
in `panel.js`. The enhancement's trust strip and Don table necessarily *display*
those seat-authored fields, which the probe's own comment calls out as
"conditional logic on these terms".

This is a **frozen architectural boundary**, owned by Chiave / the original spec —
not a test-staleness question. The probe was deliberately **left intact and failing**
rather than weakened. It needs an upstream ruling.

---

## 4. Fixes applied on the recovery branch

1. **Keyboard contract restored.** `Ctrl+Alt+1..7` keep their original v1.2.0
   meanings (Bootstrap, Re-Center, Frame, State, Anchor, Handoff, End) — the
   mapping documented in `SETUP_FOR_DON.md`. 1.3.2 had reassigned 2–7 and pushed
   End to `8`. New controls moved to `Ctrl+Alt+8/9` (Promote, Supersede) and
   `Ctrl+Shift+C/H/B/P` (Capisce, Hold, Branch, Park) — two modifiers only.
2. **Projection reconciled to the real broadcast.** `normalizeSnapshot()` is the
   single place that unwraps the background's
   `{topState, session, controls, lastState, stateAgeMs, latest, outstandingCount}`
   wrapper into the flat state the renderers expect. Verified end-to-end by
   `real-handshake-fidelity.js` (13/13), which feeds the background's own
   broadcast into the panel's own render path.
3. **Single source of truth restored.** `panel.js` read `GCEProtocolModule`, but
   `panel.html` never loaded `protocol.js` and `protocol.js` published only
   `module.exports` — so the panel **always** fell back to a hardcoded, divergent
   control list. The D-21 "fix" in the 1.3.2 lineage was inert. Fixed:
   `panel.html` now loads `../lib/protocol.js`, and `protocol.js` publishes
   `globalThis.GCEProtocolModule`.
4. **HTML injection sink closed.** `openEndDialog()` built `innerHTML` from
   seat-authored `CHECKPOINT` / `HANDOFF_STATE`. Those values come from the ChatGPT
   page via the ACK STATE block, so this was a live injection sink into a privileged
   `moz-extension://` panel. Rebuilt with `createElement` + `textContent`.
   *(This sink was not in Luce's finding — it is the same class Luce required to be
   fixed in the same change as the parser.)*
5. **Harness bug fixed.** `surface-integration-test.js` bound
   `sandbox.GCEProtocol`, which is always `undefined` (a top-level `const` is a
   lexical binding, not a sandbox property). It now captures the CommonJS export
   before `main.js` overwrites it. Real score **14/14**, confirming Luce's
   diagnosis that 12/14 was a harness artefact, not product signal.
6. **Stale probes corrected.** R7/R10 asserted *exactly 7* controls. Converted to
   superset assertions (all 7 baseline controls still served, plus the new ones).
   Membership is the contract; display order legitimately changed when
   `RECENTER_SESSION` was promoted to the vernacular row.

---

## 5. Regression contract

| Half | Result |
|---|---|
| OLD PRODUCT STILL WORKS | `run-tests.js` T1–T8 **9/9 PASS** · baseline shortcuts intact · R7 confirms all 7 v1 controls still served |
| NEW FUNCTIONALITY WORKS | `surface-integration-test.js` **14/14** · `real-handshake-fidelity.js` **13/13** · `security-regression.js` **all pass** |
| Packaging integrity | `build-xpi.js` self-verifies: forward slashes, no `META-INF`, every entry round-trips byte-identically |
| Manifest validity | valid JSON, root-level, 13 commands, no duplicate/unknown/≥3-modifier shortcuts |
| Startup / entry behavior | `browser-wiring-probe.js` (R10) **PASS** — background scripts link in one shared global scope, `onMessage` answers, `onCommand` registered |
| Security tests | payload allowlist, required keys, size ceiling, truncated-ACK, Park Shelf injection — **all pass** |
| Native install | **PROVEN** — v1.4.0 installs and registers ACTIVE in real Floorp 157 |
| `regression-probes.js` | 15/16 — R8 fails by design (§3 conflict, not suppressed) |

**NATIVE_INSTALL_PROVEN: YES**

Proof is reproducible: `node build-xpi.js extension gce-don-control-bar-1.4.0.xpi`
then `node test/native-install-proof.js gce-don-control-bar-1.4.0.xpi`.
Both use a throwaway profile with `-no-remote`; Don's running Floorp was never
touched and Don was never used as QA.

---

## 6. Release position

The governing equation was
`CONTROL BAR NEXT VERSION = WORKING CONTROL BAR + VERIFIED ENHANCEMENTS`.

That equation is now satisfied on the build side: `1.4.0` is the known-good
delivery lineage plus the verified enhancement surface, and it installs natively.

**This is NOT a release declaration.** Per the verification rule, independent
verification is **Luce's** gate, not Nico's. `1.4.0` is a **candidate for Luce**,
and stays one until Luce returns.