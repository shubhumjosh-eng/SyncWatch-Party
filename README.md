# SyncWatch Party

Everyone in the same frame. Friends join with a link or room code, watch in sync, chat with timestamped messages, take a voice/video call, share a screen or tab, draw together, react on a timeline, and cut highlight clips that are encoded entirely in the browser with FFmpeg.wasm.

Built for the **CSC Winter Sparkathon** — technology that helps people share an experience.

## Links

- **Live demo:** https://syncwatch-party-production.up.railway.app
- **Source code:** https://github.com/shubhumjosh-eng/SyncWatch-Party
- **Demo video:** `assets/demo.mp4` (18s; upload to YouTube/Vimeo for Devpost)
- **Devpost copy and checklist:** `DEVPOST_SUBMISSION.md`

## Quick start

```bash
npm install
npm start
```

Open `http://localhost:3000`. Open a second tab (or share your LAN URL) with the same room code to see sync, presence, chat, drawing, reactions, calls, and clipping.

## One-minute judge demo

1. Open `http://localhost:3000?room=SPARK` in two tabs, or use **Copy invite link** to share the room.
2. Both tabs show `Online`; the first tab is `Host`.
3. Press **Play** in the host tab. The guest tab starts within a few hundred milliseconds; guests cannot override playback.
4. Type `hello @00:02` in **Room chat** and press **Send**. Click the timestamp to seek.
5. Press **Join call** in both tabs to create local camera previews and peer video tiles.
6. Press **Share screen** in the host tab and choose a tab/window. Guests automatically see the live stream, including late joiners.
7. Press **Pen** or **Arrow** and draw on the video; toggle **Auto-fade** and color swatches.
8. Press **Clip that** in both tabs within five seconds, or use **Clip now**. Both browsers produce an 8-second MP4 with a 4-second pre-roll.
9. Make two clips, then press **Stitch reel** to concatenate them into one downloadable MP4.

## Features

- **NTP-style sync** — clock offset, RTT, and drift telemetry; host-authoritative play/pause/seek with `playbackRate` correction.
- **Room chat** — WebSocket broadcast with user color badges and clickable `@M:SS` timestamps that seek the player. Blank messages are dropped.
- **Reactions** — floating emoji over the video and markers on a timeline reaction strip.
- **WebRTC call** — camera/mic stream (`kind: 'cam'`) with Join Call, Mic Mute, Cam Toggle, and compact live peer tiles.
- **Screen share** — host `getDisplayMedia` stream (`kind: 'screen'`), muted locally to prevent echo, relayed over the room WebSocket so it works across different networks, with browser-bar stop handling and automatic delivery to late joiners.
- **Watch anything** — built-in CC0 samples, direct `.mp4`/`.webm` URL input, local file picker, and drag/drop file loading. Host broadcasts `mediaSource` changes to guests.
- **Telestrator** — normalized `[0..1]` pen and arrow coordinates, color swatches, and 3.5s auto-fade.
- **Clipping** — consensus or manual clips, a rolling 30-second WebM buffer for live screenshares, and multi-clip reel stitching.
- **COEP credentialless** — keeps SharedArrayBuffer available for FFmpeg.wasm while allowing external media playback.
- **Byte-range media** — the server returns `206 Partial Content` with `Accept-Ranges: bytes`, so seeking and clickable `@MM:SS` chat timestamps work.

## Architecture

- `server/index.js` — Node HTTP server + `ws` WebSocket rooms. Relays playback state, presence, NTP pings, strokes, chat, reactions, clip votes, media-source changes, and targeted WebRTC signaling (`rtc-offer`, `rtc-answer`, `rtc-ice`, `rtc-leave`, `rtc-meta`). Server-assigned client IDs, per-room signaling checks, message validation, rate limits, and a 256 KB payload cap keep rooms isolated.
- `public/js/syncEngine.js` — NTP offset/RTT, target playback time, seek on large error, drift correction.
- `public/js/telestrator.js` — canvas overlay with normalized coordinates, color selection, and auto-fade.
- `public/js/clipConsensus.js` — 5-second majority clip trigger.
- `public/js/rtcCall.js` — `RTCPeerConnection` with `stun:stun.l.google.com:19302`, one connection per peer per stream kind.
- `public/js/ffmpegWorker.js` — Web Worker. Loads `@ffmpeg/core` ESM from same-origin blob URLs, clips URL/buffer inputs, and stitches clips with the concat demuxer. Jobs are serialized, use per-job filenames, clean up MEMFS in `finally`, and re-encode reels for consistent output.
- `public/js/app.js` — room controller tying sync, chat, reactions, RTC, media sources, telestrator, and clipping together.
- `public/js/shared.mjs` — pure range/timestamp/seek helpers shared with Node regression tests.
- `public/samples/` — small CC0 sample videos from MDN's interactive examples.

## Deploying

This app needs a **long-running Node process** for WebSockets. Deploy on Railway, Render, Fly.io, or any Node host that supports persistent WebSocket connections.

`railway.json` and `render.yaml` are included. The server reads `process.env.PORT`, so no code changes are needed.

Vercel/Netlify serverless functions are **not** a good fit for the `ws` server.

Set `ALLOWED_ORIGINS` to a comma-separated list of trusted origins if the app is served from a different host than the WebSocket endpoint.

### WebRTC / TURN

- **Screen sharing is relayed over the room WebSocket**, not WebRTC, so it works between laptops on different networks without any TURN server. The host sends adaptive WebP/JPEG frames (up to ~15 fps, capped at 960×540 and 220 KB per frame) with socket backpressure protection, and guests render them into a canvas-backed video tile.
- Camera calls still use WebRTC. The server exposes `/rtc-config.json`, which the client loads before creating peer connections.
- If you want TURN fallback for camera calls, set `TURN_URL` (comma-separated `turn:`/`turns:` URLs), `TURN_USERNAME`, and `TURN_CREDENTIAL` in your host's environment. No credentials are stored in the repo.
- Leave `TURN_URL` unset for STUN-only camera calls; set it to an empty string to explicitly disable TURN.
- The browser logs ICE and connection state transitions in the room log, so a failed camera connection is visible immediately.

## Tests

```bash
npm test        # 24 tests: ranges, rooms, relay, signaling, client helpers, validation
npm run check   # syntax check every JS module
```

## Built-in sample attribution

`flower.mp4` and `friday.mp4` come from MDN's CC0 interactive examples: `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/`.

## AI-use disclosure (draft)

> Used an AI coding assistant for architecture planning, scaffolding the Node/WebSocket server, the sync and canvas modules, WebRTC signaling, the FFmpeg.wasm worker, the chat/reaction UI, and debugging. All final code was reviewed and tested manually in a browser, including two-tab sync, chat, reactions, local camera preview, clip encoding, and reel stitching. No external AI service is called by the submitted app at runtime.

## Screenshots

- `assets/devpost-home.png` — main room UI.
- `assets/devpost-two-tabs.png` — host view with two peers and playback.
- `assets/devpost-features.png` — guest view with chat, reactions, and peer list.

## Known limitations

- No authentication or accounts — room codes are lightweight demo identifiers; empty rooms are deleted immediately and the server caps active rooms at 64.
- A guest cannot access another user's local file; the host broadcasts only a notice for local files.
- Screen clips use a rolling ~30s WebM buffer and depend on browser `MediaRecorder` support.
- Screen relay quality depends on the room server's bandwidth and uses adaptive WebP/JPEG frames up to ~15 fps rather than a native 30 fps desktop stream. It still carries audio through the separate WebRTC call, not through the relay.
- Camera-call quality still depends on the network; configure your own `TURN_*` credentials if STUN alone fails. Remote call audio starts muted and must be enabled per tile.
- The host is a single point of playback authority; if the host leaves, the next peer becomes host and the previous screen share is reset.
- Clipping a remote URL requires that origin to allow cross-origin `fetch` (CORS); playback alone does not. Local files and live screen shares can only be clipped by the device that owns them.
- Reel stitching re-encodes with a uniform codec and 30 fps, so it is slower than stream copy and normalizes frame timing.
- Render free web services sleep after idle, which disconnects WebSocket rooms; use an always-on plan for real use.
- Older browsers without module Workers, `ResizeObserver`, or `aspect-ratio` are not supported.
