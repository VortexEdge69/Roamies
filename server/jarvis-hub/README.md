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
2. On the VPS, one command:

```sh
curl -fsSL https://raw.githubusercontent.com/VortexEdge69/Roamies/main/server/jarvis-hub/deploy/install.sh | sudo bash -s -- jarvis.vecrahost.in
```

Partway through it shows a **claude.ai link**: open it on your phone, sign in with your Claude Pro/Max account, approve, and paste the token it shows back into the terminal. That signs Jarvis's brain in with your subscription; no API key. (Renew or switch accounts later with `sudo bash /opt/jarvis/server/jarvis-hub/deploy/login.sh`.) For voice (pendant, phone talk), add a free Groq key: put `GROQ_API_KEY=gsk_...` before `bash` in the command, or in `.env` later.

It installs Node 22, Caddy (automatic HTTPS), the hub as the `jarvis-hub` service, a firewall (22/80/443 only) and a daily self-update that rolls back on failure. On first install it prints a token for `desktop`, `phone` and `pendant`, a one-tap `jarvis://pair` link for the Android app, and the desktop `hub.json` line. Run it again any time; it keeps your `.env`, data and tokens.

Manage devices later:

```sh
cd /opt/jarvis/server/jarvis-hub
sudo -u jarvis node src/cli.mjs add tablet phone
sudo -u jarvis node src/cli.mjs list
sudo -u jarvis node src/cli.mjs remove phone    # revoke a lost device
sudo -u jarvis node src/cli.mjs doctor [token]  # why is a token rejected? checks owners, files, the running hub
sudo node src/cli.mjs repair                    # bring back devices lost to unreadable/corrupt devices.json
```

## Connect your devices

**Windows / Mac desktop (Roamies).** Create `%USERPROFILE%\.gg\sidekick\hub.json` (Windows) or `~/.gg/sidekick/hub.json` (Mac):

```json
{ "url": "https://jarvis.vecrahost.in", "token": "jh_...", "name": "desktop" }
```

Restart Roamies. It syncs memory and conversations, speaks lines sent from the phone, and runs requests handed to it. Without that file Roamies behaves exactly as before.

**Android app.** Install the APK from this repo's latest *Jarvis* release, then open the `jarvis://pair` link the installer printed (or paste the hub address and phone token). Turn on *Always listening* to hear "Jarvis" with the screen off. Without the app: open the hub URL in Chrome and *Add to Home screen*. You get the JARVIS globe with your memory drawn around it as a brain (tap **Brain** for the list), hold-to-talk, spoken replies, and *Hey Jarvis* while the app is open. *Run on desktop* sends requests straight to your computer.

**Mic pendant.** Connect a WebSocket to `wss://<domain>/v1/audio` with header `Authorization: Bearer <pendant token>` and subprotocol `jarvis.v1`, then:

1. send `{"type":"start","rate":16000}`
2. stream binary frames of 16-bit little-endian mono PCM while you talk (max 30 s)
3. send `{"type":"end"}`

The hub replies `{"type":"heard","text":…}` then `{"type":"reply","text":…}` (use them to blink the LED), and has a device that can speak say the answer (`HUB_SPEAKER`, or the desktop). Set `HUB_PENDANT_ROUTE=desktop` to send every pendant request to the desktop Roamies agent instead.

## API

All `/v1/*` calls need the device token, as `X-Jarvis-Token: <token>` or `Authorization: Bearer <token>`. Behind nginx use `deploy/nginx-jarvis.conf` (WebSocket upgrade headers, no `auth_basic`). WebSockets can send the token as the subprotocol `bearer.<token>` alongside `jarvis.v1` (browsers can't set headers).

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
| GET | `/v1/brain` | Notes, open commitments, digests of recent desktop conversations, facts, recent chats |
| GET/POST | `/v1/notes` | Your work notes (`{title, text, tags}`); `PUT`/`DELETE /v1/notes/:id` |
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
