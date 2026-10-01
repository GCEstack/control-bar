# Control Bar Build & Deployment

## Version

```
1.2.1
```

## Git Commit

```
314ccb1 v1.2.1: Add browser_action popup as sidebar fallback; fix panel entrypoint
```

## Source Location

```
C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar\
```

## Permanent Floorp Deployment

### Current State
- Extension is loaded via about:debugging (temporary load)
- This requires manual reload after Floorp restart

### Permanent Installation Method

1. **Package the extension:**
   - Open about:debugging in Floorp
   - Click "Load Temporary Add-on..."
   - Navigate to: `C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar\extension\manifest.json`
   - The extension ID is: `gce-don-control-bar@don.local`

2. **Make it permanent (for this profile):**
   - The extension loads into profile: `h6q809pa.default-release`
   - Data stored in: `browser-extension-data\gce-don-control-bar@don.local`
   - Floorp stores temporary extensions in browser-extension-data
   - To make permanent: extension needs to be signed OR installed as a "development" extension

3. **For full permanence (requires signing):**
   - Submit to Floorp add-on store, OR
   - Use Firefox developer/signing pipeline, OR
   - Keep as "temporary" but document the reload procedure

### Upgrade Procedure

1. Stop Floorp
2. Backup: `cp -r extension extension.backup`
3. Pull new version from Git
4. Open about:debugging
5. Click "Reload" on the extension
6. Verify in sidebar

### Rollback

1. Stop Floorp
2. Restore: `rm -rf extension; mv extension.backup extension`
3. Open about:debugging
4. Click "Reload" on the extension
5. Commit hash: `git log --oneline -1` to verify

## Test Commands

```bash
# Run core tests
cd C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar\test
node run-tests.js

# Run regression probes
node regression-probes.js

# Check manifest
cat extension/manifest.json | jq .version
```

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