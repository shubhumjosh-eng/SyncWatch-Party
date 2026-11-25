# SyncWatch Party

A zero-install, real-time co-op watch room. Friends join the same room code, watch in sync, draw on a shared canvas, and clip a highlight that is encoded entirely in the browser with FFmpeg.wasm.

Built for the **CSC Winter Sparkathon** — technology that helps people share an experience.

## Quick start

```bash
npm install
npm start
```

Open `http://localhost:3000`. Open a second tab (or share your LAN URL) with the same room code to see sync, presence, drawing, and consensus clipping.

## One-minute judge demo

1. Open `http://localhost:3000?room=SPARK` in two tabs.
2. Both tabs show `ONLINE`; the first tab is `HOST`.
3. Press **PLAY** in the host tab. The guest tab starts within a few hundred milliseconds. Telemetry badges show offset, RTT, and drift.
4. Press **PEN** or **ARROW** and draw on the video. The stroke appears in the other tab.
5. Press **CLIP THAT** in both tabs within five seconds. Consensus triggers and both browsers produce an 8-second MP4 with libx264.
6. Download the MP4 from **CLIP REEL**.

Use **CLIP NOW** for a single-user demo — it clips immediately without consensus.

## Architecture

- `server/index.js` — Node HTTP server + `ws` WebSocket rooms. Relays playback state, strokes, presence, NTP pings, and clip votes. The first client in a room is the host; playback authority stays with the host.
- `public/js/syncEngine.js` — NTP-style ping/pong clock offset, RTT estimation, target playback time from host state, and small `playbackRate` drift correction. Large errors trigger a seek.
- `public/js/telestrator.js` — Canvas overlay with normalized `[0..1]` coordinates so strokes line up across screen sizes. Pen and arrow tools.
- `public/js/clipConsensus.js` — Sliding-window vote detector; the server requires a majority of connected peers within five seconds.
- `public/js/ffmpegWorker.js` — Web Worker. Loads `@ffmpeg/core` ESM from same-origin blob URLs, writes the sample video into the FFmpeg virtual filesystem, trims it, and returns an MP4 blob.
- `public/samples/` — Small CC0 sample videos from MDN's interactive examples, bundled so the demo works offline.
- COOP/COEP headers are set on every response so SharedArrayBuffer is available to FFmpeg.wasm.

## Deploying

This app needs a **long-running Node process** for WebSockets. Deploy it on Render, Railway, Fly.io, or any Node host that supports persistent connections and outbound WebSocket upgrades.

Vercel/Netlify serverless functions are **not** a good fit for the `ws` server. If you must use them, split the static site from a separate WebSocket service.

Set `PORT` from your host if required; the server already reads `process.env.PORT`.

## Built-in sample attribution

- `flower.mp4` and `friday.mp4` come from MDN's CC0 interactive examples: `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/`.

## AI-use disclosure (draft)

> Used an AI coding assistant for architecture planning, scaffolding the Node/WebSocket server, the sync and canvas modules, the FFmpeg.wasm worker, and debugging. All final code was reviewed and tested manually in a browser, including a two-tab sync test and an end-to-end clip encode. No external AI service is called by the submitted app at runtime.

## Known limitations

- No authentication or accounts — room codes are lightweight demo identifiers.
- The host is a single point of playback authority; if the host leaves, the next peer becomes host.
- Clip encoding speed depends on the device; the clip is short and ultrafast to keep the demo reliable.
- Consensus requires at least two connected viewers. Use **CLIP NOW** when testing solo.
