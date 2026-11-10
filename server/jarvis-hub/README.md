# Jarvis Hub

The always-on centre of a multi-device Jarvis built on Roamies. It runs on your VPS and gives every device one shared brain.

```
             ┌──────────────── Jarvis Hub (VPS, https) ────────────────┐
             │  memory: facts · commitments · reminders (merged)       │
             │  conversations from the desktop (carry on anywhere)     │
             │  its own brain for phone / web / pendant (same memory)  │
             │  speech-to-text · wake-word arbitration · live events   │
             └───────▲──────────────────▲───────────────────▲──────────┘
        WebSocket +  │ REST             │ WebSocket         │ WebSocket (PCM audio)
                     │                  │                   │
          Desktop Roamies          Phone / browser     DIY mic pendant (ESP32)
          (local-first, works      (installable PWA,   (talk → hub transcribes →
           offline, syncs when      "Hey Jarvis",       answers → a device
           online)                  hold-to-talk)        that can speak says it)
```

- **Local-first.** The desktop keeps its own memory files and works without the hub. When the hub is reachable, changes merge both ways (newest edit wins per item; deletions sync as tombstones; duplicate facts collapse).
- **One memory everywhere.** Tell the phone "remind me to buy the mic at 6", and the desktop's reminders list has it a second later.
- **Carry on anywhere.** The desktop uploads its conversation; a desktop starting up picks the newest conversation from any device.
- **Wake arbitration.** When several devices hear "Jarvis" at once, the hub picks the one that heard it best and tells the rest to stay quiet.
- **Computer tasks from anywhere.** The hub's brain can hand a request to your desktop (`run_on_desktop`), where Roamies opens apps, clicks and types.

## Install on the VPS (Ubuntu 22.04 / 24.04)

1. Point a DNS **A record** for your domain (e.g. `jarvis.vecrahost.in`) at the VPS IP.
2. On the VPS:

```sh
curl -fsSL https://raw.githubusercontent.com/VortexEdge69/Roamies/main/server/jarvis-hub/deploy/install.sh -o install.sh
sudo bash install.sh jarvis.vecrahost.in
```

That installs Node 22, Caddy (automatic HTTPS), the hub as the `jarvis-hub` systemd service, and opens only ports 22, 80 and 443. Run it again any time to update.

3. Add keys to `/opt/jarvis/server/jarvis-hub/.env` (see `.env.example`), then `sudo systemctl restart jarvis-hub`:
   - `ANTHROPIC_API_KEY` (or any OpenAI-compatible API) for the hub's brain
   - `GROQ_API_KEY` for speech-to-text (pendant and phone voice)

4. Add a token per device (each is shown once):

```sh
cd /opt/jarvis/server/jarvis-hub
sudo -u jarvis node src/cli.mjs add desktop desktop
sudo -u jarvis node src/cli.mjs add phone phone
sudo -u jarvis node src/cli.mjs add pendant pendant
sudo -u jarvis node src/cli.mjs list             # see devices and when they were last seen
sudo -u jarvis node src/cli.mjs remove phone    # revoke a lost device
```

## Connect your devices

**Windows / Mac desktop (Roamies).** Create `%USERPROFILE%\.gg\sidekick\hub.json` (Windows) or `~/.gg/sidekick/hub.json` (Mac):

```json
{ "url": "https://jarvis.vecrahost.in", "token": "jh_...", "name": "desktop" }
```

Restart Roamies. It syncs memory and conversations, speaks lines sent from the phone, and runs requests handed to it. Without that file Roamies behaves exactly as before.

**Android.** Open `https://jarvis.vecrahost.in` in Chrome, paste the phone token, then Chrome menu → *Add to Home screen*. You get the JARVIS globe with your memory drawn around it as a brain (tap **Brain** for the list), hold-to-talk, spoken replies, and *Hey Jarvis* while the app is open. *Run on desktop* sends requests straight to your computer.

**Mic pendant.** Connect a WebSocket to `wss://<domain>/v1/audio` with header `Authorization: Bearer <pendant token>` and subprotocol `jarvis.v1`, then:

1. send `{"type":"start","rate":16000}`
2. stream binary frames of 16-bit little-endian mono PCM while you talk (max 30 s)
3. send `{"type":"end"}`

The hub replies `{"type":"heard","text":…}` then `{"type":"reply","text":…}` (use them to blink the LED), and has a device that can speak say the answer (`HUB_SPEAKER`, or the desktop). Set `HUB_PENDANT_ROUTE=desktop` to send every pendant request to the desktop Roamies agent instead.

## API

All `/v1/*` calls need `Authorization: Bearer <device token>`. WebSockets can send the token as the subprotocol `bearer.<token>` alongside `jarvis.v1` (browsers can't set headers).

| Method | Path | What |
|---|---|---|
| GET | `/health` | Up? Brain and speech-to-text configured? (no token) |
| GET | `/v1/me` | This device, online devices |
| GET | `/v1/memory` | The merged memory doc |
| POST | `/v1/memory/merge` | Merge a device's memory doc; returns the merged doc |
| GET | `/v1/sessions`, `/v1/sessions/latest`, `/v1/sessions/:id` | Conversations |
| PUT | `/v1/sessions/:id` | Upload a conversation |
| POST | `/v1/chat` | `{text, voice?, target?:"desktop"}` → `{reply}` |
| POST | `/v1/transcribe` | Audio body (webm/ogg/m4a/mp3/wav, or raw PCM16 as `application/octet-stream` with `?rate=`) → `{text}` |
| POST | `/v1/say` | `{text, target?}` make a device speak |
| GET | `/v1/devices` | Registered devices |
| WS | `/v1/live` | Events: `memory`, `say`, `prompt`, `turn`, `reminder`, `presence`, `wake_granted`/`wake_yield`. Send `hello`, `chat`, `wake`, `say`, `prompt`, `turn` |
| WS | `/v1/audio` | Pendant audio (above) |

## Develop

```sh
cd server/jarvis-hub
npm ci
cp .env.example .env    # set HUB_DATA_DIR=./data for local runs
npm run device -- add laptop desktop
npm start               # http://127.0.0.1:8787
npm test
```

Data lives in `HUB_DATA_DIR` as plain JSON (`memory.json`, `devices.json` with hashed tokens, `sessions/`). Back it up by copying the folder.

## Security notes

- Tokens are random 192-bit values stored only as SHA-256 hashes; revoke with `npm run device -- remove <name>`.
- The hub listens on 127.0.0.1; only Caddy (HTTPS) is exposed. The desktop refuses to send its token over plain `http://` to a public host.
- 20 failed token attempts from one IP lock it out for 10 minutes.
- Memory and conversations sit on your VPS: treat its disk as private.
