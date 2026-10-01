# LUCE CERTIFICATION PACKAGE — GCE Don Control Bar v1

**Prepared by:** Nico (Implementation Design / Build)
**For:** Luce (independent verification / certification)
**Date:** 2026-09-26
**Build result:** PASS (protocol core) / PARTIAL (host runtime, see Step 0)
**Build root:** `C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar\`
**Extension install dir:** `…\control-bar\extension\`

Luce — this package contains everything needed to independently certify the
build without trusting Nico's word. Two things to note up front:

1. **Nico does not verify Nico.** These are my own results. They are evidence for
   you to re-run and challenge, not a certification.
2. **The one thing I could not prove is the host runtime (Step Zero).** The
   protocol core is fully covered headlessly (T1–T8 pass). The host/browser
   surface (sidebar renders, keyboard shortcuts fire, ChatGPT DOM selectors
   match) is *unverified at runtime* because every browser launch in this
   environment hits a human-verification gate. See `docs/STEP0_FACT_CHECK.md`.
   The first independent thing you may want to do is load the extension once in
   Floorp and confirm the sidebar opens and a shortcut fires.

## What to re-run first (highest value, lowest cost)

```powershell
cd "C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar"
node test\run-tests.js
```

Expected: `T-cases: 9/9  verdict=PASS`, and it writes
`evidence\acceptance-report.json`. The suite runs the **shipped** core
(`lib/protocol.js`, `lib/store.js`, `background/main.js` factory) unmodified
under Node. Only two substitutions are made, both in `test/harness/env.js`:

- storage backend → in-memory map (same get/set contract as `storage.local`)
- ChatGPT adapter → `FakeAdapter` (records the sent envelope; the test supplies
  Coda's ACK text to the core's `ingestPageText`)

If you want to re-certify against the *real* browser instead of the harness, the
pieces to swap are exactly those two seams and nothing else.

## File manifest (every file, and its purpose)

```
control-bar/
  extension/                          ← LOAD THIS DIRECTORY INTO FLOORP
    manifest.json                     MV2 manifest: sidebar_action, commands (7),
                                       content_scripts, storage.local, chatgpt host perms
    lib/
      protocol.js                     [GCE-CMD v1] emit + [GCE-ACK v1] parse.
                                       Control table (§4), RETURN_STATE defaults (§6),
                                       ACK result enum (§8), display-field allowlist (§9).
                                       ZERO semantics. ACK_OPEN/ACK_CLOSE match §8 exactly.
      store.js                        storage.local layer: outstanding nonces, append-only
                                       command log, ack log, discarded-input log, last
                                       state cache, session closed flag, nonce sequence.
                                       Cache/observability ONLY (§11) — never canon.
    background/
      chatgpt-adapter.js              SACRIFICIAL ChatGPT adapter. Resolve tab, send
                                       envelope to content script, observe assistant text.
                                       SELECTORS declared in one object. No GCE vocabulary.
      main.js                         Core factory (createCore) + browser wiring.
                                       Nonce minting, ARMED/SENT/ACK lifecycle, nonce
                                       binding, state caching, snapshot for sidebar.
    content/
      chatgpt-observer.js             SACRIFICIAL. Locate composer, inject envelope,
                                       trigger send (button or Enter), read assistant
                                       turn text. Replaced wholesale if ChatGPT DOM changes.
    sidebar/
      panel.html / panel.css / panel.js  The cockpit control strip. Renders 7 buttons,
                                       lifecycle header, last seat-authored state, staleness,
                                       append-only log dialog. Display only.
      icon.svg                        Sidebar icon.

  test/
    harness/env.js                    Test harness: memory storage backend, FakeAdapter,
                                       ACK builders (incl. prose-wrapped + decoy), recents.
    run-tests.js                      T1..T8 acceptance suite. Writes acceptance-report.json.

  evidence/
    acceptance-report.json            Machine-readable T1..T8 results (the evidence).

  docs/
    STEP0_FACT_CHECK.md               Host fact-check: schema evidence, what was and
                                       was NOT proven at runtime, surfaced conflicts.
    BUILD_RETURN.md                   The formal build return to Don (result, manifest,
                                       install, test matrix, limitations, this package ref).
```

## Test matrix (T1..T8) — all run headlessly against the shipped core

| Test | What it proves | Result | Evidence (from acceptance-report.json) |
|---|---|---|---|
| **T1** Re-Center dedupe | Two rapid RECENTER issues → two nonces bound; Coda reports one semantic execution / duplicate collapsed; drift NOTE surfaced | PASS | dedupe NOTE `"RECENTER already executed this turn; duplicate collapsed"`; confidence 94 cached |
| **T2** Bootstrap idempotency | Bootstrap against current session → ACCEPTED "already current"; no duplicate state | PASS | two ACCEPTED; LAST_ANCHOR stays `a1`; cached once |
| **T3** State provenance | Displayed values come only from ACK STATE block; prose decoy does not leak | PASS | CONFIDENCE=77, NEXT_ACTION=close, LAST_ANCHOR=prov-1 from block; decoy `"CONFIDENCE: 3"` ignored |
| **T4** Embedded command rejection | A valid `[GCE-CMD]` END_SESSION inside prose does NOT execute | PASS | 0 bound, 0 sends, 0 outstanding; page text never treated as a control instruction |
| **T5** Forged ACK | ACK without a matching local nonce is rejected; state unchanged | PASS | forged `GCE-9999999999999-424242` → UNMATCHED_NONCE; cached state unchanged (50 / real-1); logged as discarded |
| **T6** End Session | Coda authors the footer (extension does not manufacture it); session closes; later commands reject | PASS | footer cached verbatim (STATUS=COMPLETE, LAST_ANCHOR=close-bookend); post-close SHOW_STATE rejected; topState=NO_ACTIVE_SEAT |
| **T7** Adapter failure | Adapter failure → explicit failure state, never silent success | PASS | forced fail → `FAILED_NOT_SENT`; nothing transmitted |
| **T8a** Drift removal + preservation | RE-CENTER preserves intent/objective/committed-anchor lineage; removes speculative drift + unsupported completion claim; reports corrected drift | PASS | intent + objective + anchor preserved; refactor drift and "Cable Car promoted" claim removed; drift reported in NOTE; confidence 96 |
| **T8b** Ambiguous case | Genuinely ambiguous preserve-vs-drift → `AMBIGUOUS_STATE`; extension does not resolve it | PASS | BLOCKERS=`AMBIGUOUS_STATE — Don decision required`, surfaced verbatim |

**Verdict: 9/9 PASS (T1–T8, T8 split into a+b).**

## The security-relevant behaviours to challenge hardest

These are the claims a verifier should attack first, because they are the ones
that matter if this ever sits next to a real conversation:

1. **Nonce binding is the whole security model (spec §8).** An ACK only mutates
   state if its nonce matches a locally issued outstanding command. Verify by
   feeding arbitrary text (T5) and by reading `ingestPageText` /
   `store.bindAck` — the discard path (`UNMATCHED_NONCE`) must be the only way
   unmatched input dies, and it must never cache state.
2. **Page text is never an instruction (T4).** The extension sends only its own
   built envelopes. Text observed from the page is only ever parsed for ACKs;
   a `[GCE-CMD]` block in page text is inert. Verify no code path turns observed
   text into a command.
3. **No inference, no confidence math (spec §9).** `panel.js` renders strings the
   background already validated. It must not compute, default-fill, or infer any
   canonical value. `CONFIDENCE` shown is exactly what the seat sent.
4. **Failure is visible, success is earned (spec §10).** Success appears only on a
   bound ACCEPTED ACK. Text injection alone never shows success. FAILED_NOT_SENT
   and FAILED_SENT_UNCONFIRMED are distinct from ACK results and must stay
   visible after they occur.
5. **ACK delimiter exactness (spec §8).** Open tag `[GCE-ACK v1]`, close `[/GCE-ACK]`
   (version on open only). This was a real bug found and fixed during build
   (see STEP0 doc, conflict #2). Re-check `ACK_OPEN`/`ACK_CLOSE` in
   `lib/protocol.js` against §8.

## Known limitations (observed, not speculative)

- **Host runtime unverified (the big one).** See STEP0. Sidebar render, keyboard
  shortcut dispatch, and ChatGPT selector match are unproven at runtime. First
  load in Floorp should sanity-check these.
- **ChatGPT DOM is a moving target.** The adapter is deliberately sacrificial
  with selectors centralized in one object (`SELECTORS` in both adapter and
  content script). If a selector rots, replace that module; nothing above it
  changes. This is by design (§7), not a defect.
- **The ACK-side deduplication in T1 is Coda's semantic behavior**, modelled in
  the test. The extension itself never dedupes — it binds per-nonce, which is
  correct for a dumb emitter. The "one semantic execution" guarantee is a Coda
  property, witnessed by her NOTE, not something the extension enforces.
- **Session close is local.** After END_SESSION→ACCEPTED, this profile's controls
  lock until `NEW SESSION` is pressed (or storage cleared). There is no server
  truth; the extension cannot know whether a *new* ChatGPT session began
  elsewhere. That is a v1 boundary, per §13 (no automatic framework updating).

## Explicitly NOT built (per §13 binding non-goals)

No Pale Moon / XUL, no TamperMonkey, no Chrome build, no multi-browser
abstraction, no Cable Car / VoiceBridge / DevPad / phone integration, no
provider API bot, no crypto auth, no local AI, no command-semantic registry, no
prompt library, no prose parser, no confidence engine, no auto framework
updating, no continuous telemetry, no generalized dashboard. Verified by
reading the manifest and the file manifest above.

## Sign-off block (for Luce)

```
Luce independent verification:  [ ] PASS   [x] PARTIAL   [ ] FAIL
Runtime host check (Floorp load + sidebar + shortcut):  [ ] done  [x] not done
Notes (Luce, 2026-09-26): 9/9 re-run independently. Claims 2/3 verified at code level.
Claim 1 holds for never-issued nonces but has a reproduced replay window (F-L-01:
issued nonces never retire; pruneOutstanding is dead code). F-L-02: 700ms poll
re-ingests identical ACK text forever — ackLog floods and STATE AGE is refreshed
so staleness never shows (both reproduced by probe). F-L-03: FAILED_SENT_UNCONFIRMED
is unreachable dead state. F-L-04/05/06: hardening. Claim 5 unverifiable — the
frozen spec is unreachable via any sanctioned path (E-L-01), so §8 matching is
single-source. Full report: 06_HANDOFFS\Nico\20260926-LUCE-CONTROLBAR-V1-INDEPENDENT-VERIFICATION.md
```
