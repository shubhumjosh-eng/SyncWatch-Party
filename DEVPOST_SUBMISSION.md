# Devpost submission pack — SyncWatch Party

Hackathon: **CSC Winter Sparkathon**
Category: **Agentboxd**
Team: **Solo**

## Links to paste

- **Live demo:** https://syncwatch-party-production.up.railway.app
- **Source code:** https://github.com/shubhumjosh-eng/SyncWatch-Party
- **Demo video:** upload `assets/demo.mp4` to YouTube or Vimeo, then paste the share URL here.

## Title

SyncWatch Party

## Tagline / subtitle

Watch together, perfectly in sync.

## Short description

A zero-install co-op watch room with real-time sync, timestamped chat, reactions, voice/video calls, screen sharing, shared drawing, and browser-side highlight clips.

## Long description

Watching something with friends usually means one person screenshares and everyone else watches out of sync — pausing, rewinding, and missing the same moments. SyncWatch Party fixes that with a link and a room code: everyone lands in the same room, the host controls playback, and every browser converges on the same timestamp using NTP-style offset, RTT, and drift measurements.

The room is built as a small Node WebSocket server plus a vanilla HTML/CSS/JavaScript client. It relays presence, playback commands, chat, reactions, telestrator strokes, clip votes, media-source changes, camera-call signaling, and compressed screen-share frames. The client adds a live timeline of reactions, clickable `@MM:SS` chat timestamps that seek the video, camera/mic peer calls, host screen share that works across different networks without TURN, and a canvas overlay for drawing together over the video.

The most technically interesting part is clipping. Viewers can vote on a moment with **CLIP THAT** within a five-second window, or trigger **CLIP NOW** manually. Each browser encodes an eight-second MP4 with a four-second pre-roll using FFmpeg.wasm inside a Web Worker, then multiple clips can be stitched into one reel. Everything runs client-side, so no video ever leaves the participants' machines.

I built this solo to make shared viewing feel like being in the same room — low-friction, visual, and genuinely real-time.

## Built with / tools used

- Node.js
- `ws` (WebSocket server)
- Vanilla JavaScript
- HTML5 + CSS
- WebRTC (`RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`)
- Canvas `captureStream()` + WebSocket screen-video relay
- `MediaRecorder`
- FFmpeg.wasm (`@ffmpeg/ffmpeg`, `@ffmpeg/core`)
- Web Workers + SharedArrayBuffer via COEP `credentialless`
- Railway (deployment)
- GitHub (source control)
- Playwright (browser QA and screenshots)
- AI coding assistant (see disclosure)

## AI-use disclosure

> I used an AI coding assistant for architecture planning, scaffolding the Node/WebSocket server, the sync and canvas modules, WebRTC signaling, the FFmpeg.wasm worker, the chat/reaction UI, and debugging. I reviewed and tested all final code manually in a browser, including two-tab sync, chat, reactions, local camera preview, clip encoding, and reel stitching. No external AI service is called by the submitted app at runtime.

## Team details

- **Members:** 1 (solo participant)
- **Eligibility:** 16+, solo, Agentboxd category
- **Member 1:** [Your name] — developer, designer, tester

## 90-second demo script

| Time | Action |
| --- | --- |
| 0:00–0:08 | Show the live link and room code. Open two tabs with the same room code. |
| 0:08–0:18 | Point out `NET: ONLINE`, `ROLE: HOST/GUEST`, and `PEERS: 2`. |
| 0:18–0:30 | Host clicks **FLOWER**, then **PLAY**. Guest starts within milliseconds. |
| 0:30–0:42 | Guest types `hello @00:02` and sends. Click the timestamp to seek. |
| 0:42–0:55 | Click 🔥/⚡ reactions; show floating emoji and timeline markers. |
| 0:55–1:08 | Press **JOIN CALL** in both tabs; show local and peer video tiles. |
| 1:08–1:18 | Host presses **SHARE SCREEN** and shares a tab; guest sees the stream. |
| 1:18–1:30 | Draw with **PEN** and **ARROW**, then press **CLIP THAT** in both tabs. |
| 1:30–1:40 | Show the generated MP4 clip and **STITCH REEL** result. |
| 1:40–1:50 | Close with the GitHub link and one line about browser-side FFmpeg. |

## Submission checklist

- [ ] Upload `assets/demo.mp4` to YouTube/Vimeo (unlisted is fine).
- [ ] Paste the video URL into Devpost.
- [ ] Paste the live demo URL.
- [ ] Paste the GitHub repository URL.
- [ ] Fill title, tagline, short and long descriptions.
- [ ] Add tools under “Built With”.
- [ ] Paste the AI-use disclosure.
- [ ] Add yourself as the solo team member.
- [ ] Select the Agentboxd category if prompted.
- [ ] Submit before **2026-11-30 4:00pm GMT+8** (target: Nov 29).

## Screenshots

- `assets/devpost-home.png` — main room UI.
- `assets/devpost-two-tabs.png` — host view with two peers and playback.
- `assets/devpost-features.png` — guest view with chat, reactions, and peer list.
