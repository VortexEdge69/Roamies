# Jarvis (this fork)

Everything that turns Roamies into a multi-device Jarvis lives in a few clearly separated places, so upstream
Roamies updates merge cleanly:

| Path | What |
|---|---|
| `server/jarvis-hub/` | The VPS server: shared memory, conversations, live events, its own brain, speech-to-text, pendant audio, the web/phone UI. See its README. |
| `showcase/tauri/sidecar/sync.mjs`, `syncmerge.mjs` | Desktop ↔ hub sync (local-first). Hooks into upstream code are a few lines in `store.mjs` and `sidekick.mjs`. |
| `jarvis/android/` | The Android app: the hub's JARVIS UI plus background "Jarvis" wake word (offline, Vosk), request recording, spoken replies. |
| `jarvis/signing/` | The desktop updater's public key. The private signing keys live only in repo secrets (`JARVIS_ANDROID_KEYSTORE`, `JARVIS_SIGNING_PASSWORD`, `JARVIS_UPDATER_KEY`, `JARVIS_UPDATER_PASSWORD`). |
| `.github/workflows/jarvis-build.yml` | Builds the APK and the Windows installer, publishes a release; the desktop app updates itself from these. |
| `.github/workflows/sync-upstream.yml` | Daily: merges KenKaiii/Roamies, runs all tests, lands only if green, else alerts and leaves main alone. |

## How updates stay safe

- **Upstream Roamies:** merged daily into a test checkout; only a clean merge with every test passing reaches `main`.
  Version and updater settings are stamped at build time instead of edited in upstream files, so they never conflict.
- **Desktop app:** the Jarvis build's updater points at this fork's releases, signed with this fork's key, so an
  upstream release can never replace it with a build that lacks sync.
- **Android app:** each build has a higher version code and the same signing key, so it installs over the last one.
- **Hub on the VPS:** a daily timer pulls `main`, runs the hub tests, restarts, checks `/health`, and rolls back
  automatically on any failure. Data and `.env` are never touched.
- **Protocol:** clients and hub ignore message types they don't know, so a newer hub works with an older app and
  the other way round.
