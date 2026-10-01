# BUILD RESULT — GCE Don Control Bar v1

**BUILDER:** Nico (Implementation Design / Build)
**AUTHORITY:** Don · **ORIGINATING SEAT:** Coda · **ARCHITECTURE:** Chiave (ACCEPTED)
**MODE:** IMPLEMENTATION / BUILD / TEST · **DATE:** 2026-09-26
**POST-BUILD GATE:** Luce independent verification (not performed by Nico)

---

## 1. BUILD RESULT

```
PROTOCOL CORE ............ PASS   (T1–T8, 9/9, headless, against shipped code)
HOST RUNTIME (Step Zero) . PARTIAL (schemas proven present; live browser proof NOT obtained)
EXTENSION SHELL .......... BUILT  (installable, syntax-checked, semantics-audited)
OVERALL ................... PARTIAL
```

I am reporting **PARTIAL**, not PASS. The frozen spec's Step Zero demands direct
runtime proof inside the installed Floorp. Every browser launch in this
environment raised a human-verification challenge, and per your ruling I stopped
opening windows. So the host-runtime half of Step Zero is **honestly unproven**.
I did not relabel it as a pass. The protocol core — the part that carries the
safety properties (nonce binding, no-inference, no-manufactured-footer,
explicit-failure) — is fully built and fully tested.

---

## 2. FILE MANIFEST

Every file created, and its purpose.

### Extension (this directory is what you load into Floorp)

| File | Purpose |
|---|---|
| `extension/manifest.json` | MV2 Firefox-pattern manifest. Declares `sidebar_action`, 7 `commands` shortcuts, ChatGPT content script, `storage` permission, chatgpt.com host permissions. |
| `extension/lib/protocol.js` | Protocol layer. Emits `[GCE-CMD v1]` envelopes byte-for-byte; parses strictly-delimited `[GCE-ACK v1]` blocks. Holds the frozen control table (§4), RETURN_STATE defaults (§6), ACK result enum (§8), and the display-field allowlist (§9). **Zero GCE semantics.** |
| `extension/lib/store.js` | `storage.local` layer. Outstanding nonce records, append-only command log, ACK log, discarded-protocol-input log, last seat-authored state cache, session-closed flag, monotonic nonce sequence. Observability/cache only — never canon (§11). |
| `extension/background/main.js` | Control-surface core (`createCore`, environment-agnostic) + browser wiring. Mints nonces, drives ARMED→SENT→ACK lifecycle, enforces nonce binding, caches seat state, exposes sidebar snapshot, wires `commands.onCommand` and the observer poll. |
| `extension/background/chatgpt-adapter.js` | **SACRIFICIAL** ChatGPT transport adapter. Resolves the active ChatGPT tab, hands the envelope to the content script, pulls assistant output text back. Selectors declared in one `SELECTORS` object. Knows nothing about GCE. |
| `extension/content/chatgpt-observer.js` | **SACRIFICIAL** DOM half. Locates the composer, places the envelope, triggers send (button or Enter), reads the newest assistant turn. Replaced wholesale if ChatGPT's DOM changes. |
| `extension/sidebar/panel.html` | Sidebar shell markup. |
| `extension/sidebar/panel.css` | Compact cockpit styling. Dark, small, 2-column control grid. |
| `extension/sidebar/panel.js` | Display logic ONLY. Renders 7 buttons, lifecycle header, last seat-authored state, state age, append-only log dialog. Does not parse prose, infer state, or compute confidence. |
| `extension/sidebar/icon.svg` | Sidebar icon. |

### Test + evidence + docs (not loaded into the browser)

| File | Purpose |
|---|---|
| `test/harness/env.js` | Headless harness. In-memory storage backend, `FakeAdapter`, ACK builders (incl. prose-wrapped with decoys), recentered-state fixture. |
| `test/run-tests.js` | T1–T8 acceptance suite. Runs the **shipped** core unmodified under Node. Writes `evidence/acceptance-report.json`. |
| `evidence/acceptance-report.json` | Machine-readable T1–T8 results. The preserved evidence. |
| `docs/STEP0_FACT_CHECK.md` | Step Zero: host schema evidence, what was and was NOT proven at runtime, and the two surfaced conflicts. |
| `docs/LUCE_PACKAGE.md` | The exact artifact/evidence package for Luce's independent certification. |
| `docs/BUILD_RETURN.md` | This document. |

Self-audit performed: `node --check` on all 6 extension JS files (all OK);
`manifest.json` parses as valid JSON; forbidden-semantics grep across the
extension found no leaked governance logic (only the manifest description
stating it carries zero semantics).

---

## 3. INSTALL PATH

```
C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar\extension
```

That directory is the unpacked extension root (it contains `manifest.json`).

---

## 4. INSTALL INSTRUCTIONS (Floorp)

1. Open Floorp.
2. Go to `about:addons` (or `about:debugging` → **This Firefox**).
3. Click the gear / **Tools** menu → **Load Temporary Add-on…**
   (on `about:debugging` it is the **Load Temporary Add-on…** button).
4. Select `…\control-bar\extension\manifest.json`.
5. The **GCE Don Control Bar** appears. Open the sidebar (View → Sidebar, or the
   sidebar icon). You should see the 7-button control strip.
6. Open a ChatGPT tab (`https://chatgpt.com`) so the adapter has a target.
7. Note: a *temporary* add-on is removed when Floorp closes. For a persistent
   install, Floorp must accept a signed extension or you use a developer build /
   `xpinstall.signatures.required=false` in a dedicated profile. For v1 testing,
   temporary load is the intended path.

Keyboard shortcuts (once loaded): `Ctrl+Alt+1..7` map to
Bootstrap / Re-Center / Frame / State / Anchor / Handoff / End.

---

## 5. STEP-0 RESULT (actual Floorp evidence)

**Host identified:** Floorp 12.18.1 (Gecko 156.0.1), running and installed on
this machine.

**Schemas present in the installed host (direct archive read):**
- `sidebar_action.json` — present (`browser\omni.ja`)
- `commands.json` — present (`browser\omni.ja`)
- `content_scripts.json` — present (`omni.ja`)
- `storage.json` — present (`omni.ja`)

**Runtime probe:** attempted (disposable test extension + throwaway profile +
Marionette driver), **not completed** — human-verification gate in this
environment; per your ruling, no further windows opened. Runtime capabilities
(sidebar render, shortcut dispatch, ChatGPT selector match) are **unverified**.

Full detail and reproduction commands: `docs/STEP0_FACT_CHECK.md`.

**Conflicts surfaced (per §16, not silently resolved):**
1. Step Zero as written could not be satisfied (no runtime proof obtainable). Not
   rewritten into a false pass.
2. A protocol-delimiter bug was found and fixed during build: §8's ACK close tag
   is `[/GCE-ACK]` (version on the open tag only). The first implementation
   derived `[/GCE-ACK v1]`, which would have rejected every real ACK. Corrected
   to match spec. Flagged because a verifier should re-check it.

---

## 6. TEST MATRIX

| Test | Result | Evidence |
|---|---|---|
| T1 — Re-Center dedupe | **PASS** | Two nonces issued and bound; Coda NOTE reports duplicate collapsed (one semantic execution); drift NOTE visible; confidence 94 cached. |
| T2 — Bootstrap idempotency | **PASS** | Second Bootstrap → `ACCEPTED` "already current; ensure-op idempotent"; no duplicate bootstrap state; LAST_ANCHOR stable. |
| T3 — State provenance | **PASS** | Displayed CONFIDENCE/NEXT_ACTION/LAST_ANCHOR sourced exclusively from ACK STATE block; prose decoy `CONFIDENCE: 3` did not leak. |
| T4 — Embedded command rejection | **PASS** | Valid `[GCE-CMD]` END_SESSION inside prose → 0 executions, 0 sends, 0 outstanding nonces. |
| T5 — Forged ACK | **PASS** | Unmatched nonce → `UNMATCHED_NONCE`, discarded; cached state unchanged; logged as discarded input. |
| T6 — End Session | **PASS** | Coda's footer cached verbatim (extension did not manufacture it); session closed; subsequent commands rejected until new session. |
| T7 — Adapter failure | **PASS** | Forced adapter failure → explicit `FAILED_NOT_SENT`; no silent success. |
| T8 — PRE-TRUST DRIFT | **PASS (a+b)** | (a) accepted state, Don intent/objective, committed-anchor lineage preserved; speculative drift + unsupported completion claim removed; corrected drift reported. (b) genuinely ambiguous case → `AMBIGUOUS_STATE`, surfaced not resolved. |

**T1–T8 verdict: PASS (9/9 cases).** Machine evidence: `evidence/acceptance-report.json`.

Note: **RE-CENTER is not operationally trusted until T8 passes against the real
Coda.** T8 passing here proves the *contract* is testable and the extension
surfaces Coda's correction faithfully; the operational trust still requires a
real drifted session driven through the real ChatGPT surface. That is a Luce/Don
live exercise, not something this headless suite can certify.

---

## 7. KNOWN LIMITATIONS (observed only)

- **Host runtime unverified** (biggest gap): sidebar render, `Ctrl+Alt+1..7`
  dispatch, and ChatGPT selector match are unproven at runtime. First manual
  load should sanity-check these three.
- **ChatGPT DOM is a moving target** — by design the adapter is sacrificial with
  selectors centralized; a rotted selector means replacing that module only.
- **T1 dedupe is Coda's semantic behavior**, witnessed via her NOTE; the
  extension binds per-nonce and does not itself dedupe (correct for a dumb
  emitter).
- **Session close is local to this profile** — after END_SESSION the controls lock
  until `NEW SESSION`; the extension cannot detect a new session started
  elsewhere. v1 boundary per §13.
- No observed limitation in the protocol core itself across T1–T8.

---

## 8. LUCE PACKAGE

Prepared: `docs/LUCE_PACKAGE.md`. Contains the file manifest, the two harness
substitution seams, the full test matrix, the specific security behaviours to
challenge hardest (nonce binding, page-text-is-never-an-instruction, no-inference,
failure-visibility, ACK delimiter exactness), the known limitations, and a
sign-off block. Re-run command: `node test\run-tests.js` (expect 9/9 PASS).

---

## 9. AUTHORITY / SEPARATION

- Don: final authority. Called the Step-Zero ruling.
- Coda: semantics/governance ratified upstream; **not implemented here** — the
  extension contains zero command semantics, as required.
- Chiave: architecture accepted; **not reopened.**
- Nico: implementation authority, exercised. Did not verify own work as
  certified — that is Luce's gate.
- Luce: independent post-build certification — **pending**, package delivered.

**Non-goals honoured (§13):** no Pale Moon/XUL, no TamperMonkey, no Chrome
build, no multi-browser abstraction, no Cable Car/VoiceBridge/DevPad/phone, no
provider API bot, no crypto auth, no local AI, no command-semantic registry, no
prompt library, no prose parser, no confidence engine, no auto framework
updating, no continuous telemetry, no generalized dashboard. V1 was not turned
into V2 infrastructure.

**Next route:** Luce (independent certification).
