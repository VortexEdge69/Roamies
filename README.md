<p align="center">
  <img src="showcase/tauri/src-tauri/icons/128x128@2x.png" width="128" alt="Roamies icon">
</p>

<p align="center">
  <img src="docs/art/hero.gif" alt="Roamies: JARVIS, a glowing globe of LED dots, ripples as it says &quot;At your service.&quot; beside a mouse cursor, while Roamie, Anime Girl, Sarah and Adrian wave and hop on either side">
</p>

<p align="center">
  <strong>A little buddy that lives on your screen and keeps you on track.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/Roamies/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/Roamies?style=for-the-badge&label=Download&color=78ffe2" alt="Roamies desktop release"></a>
  <a href="https://github.com/KenKaiii/Roamies/stargazers"><img src="https://img.shields.io/github/stars/KenKaiii/Roamies?style=for-the-badge&label=Stars&color=yellow" alt="Star Roamies on GitHub"></a>
  <a href="https://github.com/KenKaiii/Roamies/releases"><img src="https://img.shields.io/github/downloads/KenKaiii/Roamies/total?style=for-the-badge&label=App%20downloads&color=2ecc71" alt="Desktop app downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://www.skool.com/raid"><img src="https://img.shields.io/badge/Skool-Free%20community-78ffe2?style=for-the-badge" alt="Free Skool community"></a>
</p>

Roamies is a little AI buddy that lives on your desktop. It stays by your cursor, talks back in its own
voice, keeps track of what you said you'd do and nudges you when it's due.

> [!TIP]
> **Want to build your own apps with AI?** A free 7-day build challenge and 20+ step-by-step projects are in my free community: **[skool.com/raid](https://www.skool.com/raid)**

> ⭐ **If Roamies keeps you on track, give it a star.** It's the main way other people find it.

## Why Roamies

- **Talk, don't type.** Hold ⌃⌥ (Ctrl+Alt on Windows), say it, let go. Circle something with the cursor while you talk and it sees what you mean.
- **It talks back.** Spoken replies in its own voice, with real feeling, through [Fish Audio](https://fish.audio).
- **It remembers.** What you said you'd do, reminders down to the second, and what matters to you.
- **It draws on your screen.** Rings the exact button to click, walks you through each step, and sketches answers beside what you're reading.
- **It does the clicking.** Opens apps, sites and files, and clicks or types in other apps for you.
- **Your subscriptions.** Sign in with Claude or ChatGPT, or use an API key (Gemini, Grok, Kimi Code and more).

| Pick your Roamie | What you get                                            |
| ---------------- | ------------------------------------------------------- |
| **JARVIS**       | **A glowing sphere of light that ripples as it speaks** |
| Roamie           | The original: a tiny glowing pixel creature             |
| Anime Girl       | A pixel anime girl                                      |
| Sarah            | A pixel woman                                           |
| Adrian           | A pixel man                                             |

<sub>Each one has its own name, voice and animations, in three sizes: Default, Small, or Cursor, a pixel pointer that rides along with your mouse.</sub>

## JARVIS shows you how

<p align="center">
  <img src="docs/art/jarvis-shows-you-how.gif" alt="Asked &quot;How do I export this as an MP4?&quot;, JARVIS turns into its reticle cursor, rings the Format menu, then MP4, then the Export button in a video editor, waiting for each click while a caption reads each step">
</p>

Ask how to do something in any app. JARVIS turns into its cursor, rings the exact button on your real screen,
says the step out loud and waits for your click before showing the next one.

## JARVIS explains anything

<p align="center">
  <img src="docs/art/jarvis-explains.gif" alt="Asked how black holes work while reading Wikipedia, JARVIS draws an answer card tied to the page, a turning 3D black hole with its glowing disk, underlines the key sentence and adds a discovery timeline">
</p>

Ask about whatever you're looking at. JARVIS sketches the answer right beside it while it talks: cards, graphs,
timelines, photos, molecules and turning 3D models, all in its own glowing ink. Ask it to change any part, or
clear it all in one go.

## Also included

- **The Roamies panel:** click the menu bar or tray icon for what it's doing, what it remembers, and every setting.
- **Safe by default:** file edits, commands and app control stay off until you turn them on, and risky steps always ask.
- **Shows its work:** every tool plays its own animation, so you can see what it's doing.
- **Where keys live:** your Fish Audio key stays in the macOS Keychain (encrypted with Windows DPAPI on Windows). AI sign-ins are stored in `~/.gg/auth.json`, shared with GG Coder.
- **Out of the way:** no Dock or taskbar button, ⌃⌥S (Ctrl+Shift+S on Windows) shows or hides it, Esc stops a reply.
- **Updates itself:** updates are signature-checked before they install, then it restarts itself. The Windows installer isn't code-signed yet, so SmartScreen warns the first time.
- **Quick setup:** permissions, sign-in and a short chat so it gets to know you.

|                        | macOS                      | Windows                     |
| ---------------------- | -------------------------- | --------------------------- |
| Talk to it             | Yes, best on macOS 26+     | Yes, speech runs on your PC |
| Circle while talking   | Yes                        | Yes                         |
| Spoken replies         | Yes, with a Fish Audio key | Yes, with a Fish Audio key  |
| Memory and reminders   | Yes                        | Yes                         |
| Read windows and point | Yes                        | Yes                         |
| Cards and diagrams     | Yes                        | Yes                         |
| Click and type in apps | Yes                        | Yes                         |
| Ask about an area      | Yes (⌃⌥A)                  | Yes (Ctrl+Shift+A)          |

<sub>Before macOS 26, talking uses Apple's older speech recognizer, which needs Siri or Dictation turned on.</sub>

<sub>On Windows, Roamies reads other apps through UI Automation and finds words on screen with Windows' own text
recognition (it needs a Windows language with text recognition, which most have). It can't type or click in apps
running as administrator, and it borrows your cursor for real clicks, keys and scrolling, giving it back when it's done.
Windows also leaves Roamies out of every screen capture, so it won't show in your screenshots or screen shares.</sub>

<sub>Spoken replies are billed to your own Fish Audio account; the panel shows what each voice model costs. Voice on
Windows uses [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), in the ONNX export by
[istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx), run with
[parakeet-rs](https://github.com/altunenes/parakeet-rs). The model (about 670 MB) downloads once at setup and isn't bundled.</sub>

## Get started

1. Install Roamies:

   **macOS (Apple silicon or Intel):** [Download the latest release](https://github.com/KenKaiii/Roamies/releases/latest) and open the `.dmg` for your Mac (`aarch64` for Apple silicon, `x64` for Intel). Requires macOS 13.5 or later.

   **Windows:** [Download the latest release](https://github.com/KenKaiii/Roamies/releases/latest) and run the `.exe` installer. Requires Windows 10 or later. It isn't code-signed yet, so Windows shows a SmartScreen warning the first time: click **More info**, then **Run anyway**.

   **Development:** With Rust, Node.js 22+, the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and, on macOS, the Xcode Command Line Tools installed:

   ```bash
   git clone https://github.com/KenKaiii/Roamies.git
   cd Roamies/showcase/tauri
   (cd sidecar && npm ci && npm test)
   ./build.sh dev        # debug build
   ./build.sh            # release bundle for this OS
   ```

2. Open the app, follow the setup guide, pick your Roamie, and hold ⌃⌥ to say hi.

<sub>The first time you sign in with Claude, Roamies downloads Claude Code (about 140 MB). On Windows, the voice model (about 670 MB) downloads once at setup.</sub>

## Privacy

Roamies has no analytics, and nothing is collected by the developer. Your messages, and screenshots when you ask
about the screen, go to the AI provider you pick. [PRIVACY.md](PRIVACY.md) lists what's sent where.

## Uninstall

**macOS:**

1. Turn off **Open at login** (panel > Behavior), then quit Roamies from the menu bar.
2. Drag Roamies from Applications to the Trash.
3. Delete `~/.gg/sidekick` and `~/.gg/sidekick.json`. Keep `~/.gg/auth.json` if you use GG Coder.
4. Open Keychain Access, search for "Roamies" and delete the Fish Audio key.

**Windows:**

1. Turn off **Open at login** (panel > Behavior), then uninstall Roamies from Settings > Apps.
2. Delete `%USERPROFILE%\.gg\sidekick` and `%USERPROFILE%\.gg\sidekick.json`. Keep `auth.json` if you use GG Coder.
3. Delete the voice model folder, `%LOCALAPPDATA%\Roamies\models`.

## Jarvis on every device (this fork)

This fork adds **Jarvis Hub** ([`server/jarvis-hub`](server/jarvis-hub)): a small server for your VPS that gives the desktop app, your phone and a DIY mic pendant one shared memory and conversation history. Roamies stays local-first and works offline; add `~/.gg/sidekick/hub.json` with your hub URL and device token to turn syncing on. See the [hub README](server/jarvis-hub/README.md) for the one-command Ubuntu install, the installable phone client and the pendant protocol.

## Build with the framework

Every Roamie's brain is a [gg-framework](https://github.com/KenKaiii/gg-framework) agent running in a Node
sidecar. Want to build your own? Install just what you need.

- [**@kenkaiiii/gg-ai**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-ai/README.md): Connect to AI providers and stream responses.
- [**@kenkaiiii/gg-agent**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-agent/README.md): Build agents that use your tools and work through tasks.
- [**@kenkaiiii/gg-core**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-core/README.md): Model selection, authentication, and local model discovery.

For your own agent, start here:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

The package links above cover setup and usage. Roamies is licensed under [AGPL-3.0](LICENSE): you can build
on it, and if you distribute your changes or run them as a network service, you share their source under
the same license.

## Contributing

Bug reports, ideas and pull requests are welcome. [Open an issue](https://github.com/KenKaiii/Roamies/issues)
to get started, read [CONTRIBUTING.md](CONTRIBUTING.md) before a pull request, and report security problems as described in [SECURITY.md](SECURITY.md).

## Learn with me

New to building with AI? Start in **[RAID](https://www.skool.com/raid)**, my free community:

- A free 7-day challenge: build your first app, one short lesson a day
- 20+ step-by-step projects you can build yourself

## Star history

<a href="https://star-history.com/#KenKaiii/Roamies&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KenKaiii/Roamies&amp;type=Date&amp;theme=dark">
    <img alt="Roamies star history chart" src="https://api.star-history.com/svg?repos=KenKaiii/Roamies&amp;type=Date">
  </picture>
</a>

<p align="center">If Roamies is useful to you, ⭐ star the repo so more people find it.</p>
