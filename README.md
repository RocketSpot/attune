# Attune

**Attune** is a native Windows desktop app to control your **CMF Buds Pro 2** (and
other Nothing / CMF earbuds) — battery, ANC, EQ, gestures and more — with a clean,
CMF-themed UI and a **Smart Tuning** mode that auto-matches your EQ to whatever music
is playing.

It talks to the buds over **Bluetooth Serial (RFCOMM/SPP)**, the same way the web app
[ear (web)](https://earweb.bttl.xyz/) does, building on the open-source
[`ear-web`](https://github.com/radiance-project/ear-web) protocol. Unofficial — not
affiliated with, sponsored by, or endorsed by Nothing Technology.

> ⚠️ The releases are **unsigned**. On first launch Windows SmartScreen may say
> "Windows protected your PC" → **More info ▸ Run anyway**.

## Features

- **Full device control** — battery (L / R / case), ANC (Off / Transparency / Noise
  Cancellation + Low / Mid / High / Adaptive), EQ presets, custom 3-band EQ, Advanced
  EQ, Bass Enhance, In-Ear Detection, Low-Latency mode, gesture customization, ear-tip
  fit test, find-my-buds, and firmware version.
- **Earbud Colour + theme** — switch between Dark Grey / Light Grey / Orange / Blue;
  the earbud artwork **and** the whole app accent recolour to match.
- **Smart Tuning** *(off by default)* — detects the song playing in **any** app
  (Spotify, browsers, Apple Music…) via Windows System Media, looks up its genre, and
  auto-sets the EQ — with an optional "also adjust Bass" toggle. ANC stays manual on
  purpose so it never changes your awareness unexpectedly.
- **Music Sources** — *System Media (Windows)* needs zero setup; **Spotify** can be
  connected (optional) for more accurate genre tuning.

## Install / run

Grab a build from `dist/` (or the [Releases](#) page once published):

- **`Attune Setup 1.1.0.exe`** — installer (Start Menu + Desktop shortcuts).
- **`Attune-Portable.exe`** — no install, just double-click.

### Before connecting
1. **Pair the CMF Buds Pro 2 in Windows** → Settings ▸ Bluetooth & devices ▸ Add device.
2. Take the buds **out of the case** so they're awake.
3. Launch Attune, click **Connect**, and pick the buds from the chooser.

### Connecting Spotify (optional)
Smart Tuning works out of the box via System Media. For better genre data:
Music Sources ▸ Spotify ▸ Connect → create a free app at
[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), add the
redirect URI `http://127.0.0.1:8888/callback`, paste the Client ID, and authorize.

## Build from source

Requires Node.js 18+ on Windows.

```bash
npm install      # Electron + electron-builder
npm start        # run in dev
npm run dist     # build installer + portable into dist/
```

Dev-only diagnostic env vars: `CMF_SMOKE=1`, `CMF_DEMO=1`, `CMF_SHOT=path.png`,
`CMF_BLUE=1`, `CMF_SCROLL=<px>`.

## How it works

| File | Role |
|------|------|
| `src/main/main.js` | Electron main; frameless window; **`select-serial-port`** auto-picks the Bluetooth SPP port; serial permissions. |
| `src/main/media.js` | Smart Tuning backend: Windows SMTC media detection (PowerShell), iTunes/Spotify genre lookup, Spotify PKCE OAuth. |
| `src/main/preload.js` | Context-isolated bridge (window controls, media + Spotify IPC). |
| `src/renderer/protocol.js` | Byte-level CMF/Nothing protocol (framing, CRC-16, handshake, all commands), ported from `ear-web`. |
| `src/renderer/app.js` | The UI: wires every control to the protocol + the Smart Tuning rules engine. |
| `src/renderer/index.html` · `theme.css` | The CMF-themed single-page interface. |
| `build/make-icon.js` | Generates the app icon (Electron-rasterized SVG → multi-size `.ico`). |

CMF Buds Pro 2 is internally model **B172** (codename `espeon`). The protocol layer
also recognizes other Nothing/CMF devices; the UI is tuned for the Pro 2.

### Notes
- Smart Tuning's media detection uses **Windows PowerShell 5.1** (it can project the
  WinRT System Media APIs; PowerShell 7 cannot). All network/OS calls happen in the
  main process so the renderer stays sandboxed (locked-down CSP, no remote requests).

## License

[AGPL-3.0](LICENSE) — matching the upstream `ear-web` project this builds on.
All earbud/product trademarks and assets belong to Nothing Technology Limited.
