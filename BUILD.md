# Control Bar Build & Deployment

## Version

```
1.5.1
```

## Git Commit

```
247887a  v1.5.1: identity contract + three-question restoration + Don's seven corrections
daa1848  render proof: unwrap Marionette script return before the READY check
```

`962f283` (v1.4.0) is the frozen spine. It is an ancestor of HEAD and must
stay that way.

## Source Location

```
C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar\
```

## INSTALL (the only supported path)

```
node tools/install-live.js --xpi gce-don-control-bar-1.5.1.xpi
```

This installs through the browser's own AddonManager (Marionette
`Addon:Install`) into Don's live profile, then verifies from the profile's own
`extensions.json`. If the browser accepts the package but does not register
it, the verdict is `NOT PROVEN` — an install that cannot be seen in the
registration record is not an install.

**Close Floorp first.** The script refuses to run while it is open, because a
live profile is locked and the install would be overwritten on next launch.

## Do NOT use `install-permanent.ps1` to install

It extracts the XPI into
`%APPDATA%\Floorp\Profiles\<profile>\browser-extension-data\<id>\` and reports
success. That directory is an extension **data** directory, not a code load
path — a folder dropped there cannot execute. This was confirmed on the live
profile: 13 files, manifest v1.2.0, and no entry in any `extensions.json`.

The script is retained for history and now fails loudly instead of claiming
success: it resolves its version from `manifest.json` rather than a hardcoded
`1.2.0`, refuses to run when the requested package is absent, backs up what it
is about to overwrite, and fails if the on-disk version does not match the
request.

## State as of 2026-10-01

| Property | Value |
|---|---|
| Installed version | **1.5.1**, ACTIVE, `app-profile`, unsigned |
| Live profile | `h6q809pa.default-release` |
| Extension id | `gce-don-control-bar@don.local` |
| Stale data dir | removed (backed up as `...browser-extension-data\gce-don-control-bar@don.local.backup-v1.2.0-inertdata-*`) |

## Temporary load (for development only)

`about:debugging` → Load Temporary Add-on → `extension\manifest.json`. This
disappears on close. It is not how the shipped build is deployed.

## Rollback

1. Close Floorp.
2. Restore `extensions.json` from the `.gcecb-backup-*` file next to it, or
   install a known-good XPI: `node tools/install-live.js --xpi <old>.xpi`.
3. Reopen and confirm in `about:addons`.

## Test commands

```bash
cd C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar

node build-xpi.js                                    # package
node test/run-tests.js                               # T1-T8        9/9
node test/surface-integration-test.js                # surface     14/14
node test/real-handshake-fidelity.js                 # handshake   13/13
node test/security-regression.js                     # security    all
node test/regression-probes.js                       # probes   15/16 (R8 open)
node test/native-install-proof.js gce-don-control-bar-1.5.1.xpi
node evidence/render-proof/shoot.js                  # render     10/10
```

R8 ("Zero GCE semantics in extension") is open by order: the presentation layer
reads `AUTHORITY` and `BLOCKERS` to decide how to render a seat label and
whether a blocker count is zero. Reading a GCE field in order to display it is
the panel's job.

## Architecture Summary

- **manifest.json**: v2, extension ID `gce-don-control-bar@don.local`
- **Content scripts**: `chatgpt-observer.js`, `kimi-observer.js`
- **Background**: `main.js`, `chatgpt-adapter.js`, `kimi-adapter.js`
- **Protocol**: `lib/protocol.js` (GCE-CMD/ACK)
- **Storage**: `lib/store.js` (browser storage)
- **UI**: `sidebar/panel.js`, `panel.html`, `panel.css`

## B3 Transmission Method

Current ChatGPT has no Send button. Uses Enter-key simulation:
1. Inject command into composer
2. Dispatch keydown/keypress/keyup (Enter)
3. Verify composer cleared → success
4. Otherwise → fail closed

## Observer Fix

`observe()` now returns ALL assistant turns, not just the last one.
This ensures ACKs in any turn are captured.