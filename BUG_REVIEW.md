# SyncWatch Party — bug review

Date: 2026-11-26. Severity: **P0** breaks a core flow, **P1** security/robustness, **P2** lower severity/needs verification.

## Live QA findings

### P0 — Seeking is broken in production
`GET /samples/flower.mp4` returns no `Accept-Ranges` header because `server/index.js:53-67` always returns the whole file with `200`. In the browser, `video.seekable` is `[0, 0]`, so the seek slider and clickable `@MM:SS` chat timestamps are no-ops. Repro: send `seek @00:02`, click the button, `video.currentTime` stays `0`.

**Fix:** implement HTTP byte-range handling in `serveFile()`: parse `Range: bytes=start-end`, return `206 Partial Content` with `Accept-Ranges: bytes`, `Content-Range`, and `Content-Length` for the slice. Keep the full-file path for non-range requests.

### P2 — Reel duration label is a guess
`public/js/app.js:214-228` computes `FULL REEL [0:00 -> formatTime(blob.size / 40000)]`. Two 6-second clips produced a `0:52` label because the reel was 2.0 MB. The video itself is fine; the label is wrong.

**Fix:** store real clip durations and sum them, or read the actual duration from the generated blob.

## Source review — confirmed bugs

### P0

1. **`public/js/app.js:515-529` — `stopScreenShare()` crashes when no sample tab is active.** `document.querySelector('.tab.active').dataset.src` throws after `loadUrl()`/`loadFile()` remove the `active` class. `video.srcObject` is never restored.

2. **`public/js/ffmpegWorker.js:9,58-79,81-111,113-123` — concurrent FFmpeg jobs collide.** The `async` message handler does not serialize jobs; fixed filenames and one global `currentId` cause overwrites and misattributed progress/done events.

3. **`public/js/rtcCall.js:60-69,71-90` — WebRTC offer glare.** `offer()` returns when signaling state is not `stable`, but `handleOffer()` still calls `setRemoteDescription()`. Simultaneous JOIN CALL can leave both peers in `have-local-offer`. Signal promise rejections are uncaught at `app.js:618-620`.

4. **`server/index.js:173-178,302-311` — switching rooms abandons the old room without host migration or presence broadcast.** `clientsById` also keeps a stale mapping under the new id.

5. **`server/index.js:104,265-267` — cross-room WebRTC signaling leak.** `msg.to` resolves globally in `clientsById`; no check that sender and target share a room.

6. **`server/index.js:180-188` + `app.js:559-570` — late joiners never receive the current `mediaSource`.** They see the default sample and may have play/pause disabled.

7. **`app.js:248-292,435-454` + `ffmpegWorker.js:60` — consensus clipping is broken for local files and screen shares.** Guests clip their stale sample, screen-share guests have no `screenChunks`, and `blob:` URLs produce invalid FFmpeg filenames.

### P1

8. **`server/index.js:172-178,305-306` — client-chosen IDs are unbounded/unvalidated.** Collisions overwrite room/client maps and the wrong mapping is deleted on close.

9. **`server/index.js:218-220` + `telestrator.js:114-133,150-172` — unvalidated strokes.** `points: [null]`, NaN coordinates, and unbounded point/width/id values can throw or exhaust memory.

10. **`rtcCall.js:71-114` — unvalidated SDP/ICE.** Arbitrary JSON reaches `setRemoteDescription()`/`addIceCandidate()`; rejections are uncaught and `pendingIce` has no bound.

11. **`app.js:531-549,639-645` — duplicate WebSockets and reconnect loops.** Clicking JOIN while `CONNECTING` opens a second socket; stale `onclose` handlers schedule reconnects and overwrite `netState`.

12. **`app.js:397-433,456-529` — loading a URL/file during screen share leaves sharing active.** `sharing`, recorder, tracks, and RTC screen connections remain live while `currentSource` says `url`/`local`.

13. **`app.js:96-103,452` — stale `pendingScreenStream` can attach to the wrong host.** No host/source tag and never cleared.

14. **`app.js:112-132` + `rtcCall.js:127-139,189-200` — call tile leaks and blocked remote autoplay.** `rtc-leave` never removes tiles or clears `srcObject`; server sends no peer-disconnect RTC event; remote tiles are unmuted; `leave()` never stops `localScreen` tracks.

15. **`syncEngine.js:92-101` — guest target time is unbounded.** Host time is applied before metadata is ready or beyond `video.duration`.

16. **`ffmpegWorker.js:48-79,81-111` — failed jobs leak MEMFS files.** Cleanup only runs on success.

17. **`ffmpegWorker.js:20-32` — failed FFmpeg load is cached forever.** `loading` retains the rejected promise, so retry is impossible.

18. **`app.js:28-29,170,189,211,253,342,423,780-789` — memory leaks.** Object URLs are never revoked; `clips[]`, reaction markers, `pendingScreenStream`, and job maps grow without bound while DOM is capped.

19. **`server/index.js:164-172,218-264` — no message validation, size limit, rate limiting, or Origin check.** `maxPayload` defaults to ~100 MB.

20. **`server/index.js:307-310` + `app.js:572-576,648-651` — host migration leaves screen-share state stuck.** New host inherits `kind: 'screen'` from the departed host with no stream, so play/pause stays disabled.

### P2 / needs verification

21. **`ffmpegWorker.js:65-67` — remote-URL clipping needs CORS.** Video playback can work without CORS; `fetch()` in the worker cannot. README overstates COEP `credentialless`.

22. **`ffmpegWorker.js:92-103` — concat reel is fragile.** `-c copy` across different sources/resolutions can produce broken timestamps.

23. **`app.js:666-673` — seek slider races.** `isSeeking` is only cleared by pointer events; keyboard/`pointercancel` can leave it stale.

24. **`rtcCall.js:145-146` + `server/index.js:257-264` — `rtc-meta` note is never delivered.**

25. **`package.json`, `railway.json`, `render.yaml` — deployment risks.** No `engines.node >=18`; Render free plan sleeps and kills WebSocket rooms; no healthcheck path.

26. **Older-browser compat.** Module Worker, `ResizeObserver`, `aspect-ratio`, and unmuted remote autoplay have no fallback.

## Verified OK

- NTP offset/RTT math (`syncEngine.js:54-55`, `server/index.js:193-195`) is correct.
- Vendor/public path traversal checks are adequate (`server/index.js:79-99`).
- No confirmed XSS: chat, presence, logs, and clip metadata use `textContent`/`createTextNode`.
- FFmpeg module/core loading chain is valid.
- Host migration on peer disconnect works (live QA: guest became HOST).
- Clipping and reel stitching work for built-in samples (live QA).
- Chat XSS payload was rendered as text (live QA).

## Recommended fix order

1. HTTP Range support for media files (restores seeking and timestamp clicks).
2. Server room membership/signaling hardening: server-generated IDs, `leaveRoom()`, per-room signaling target checks, message validation/size limits.
3. FFmpeg job queue, `finally` cleanup, load-retry reset, real reel duration metadata.
4. Screen-share lifecycle: stop on all source changes, guard `stopScreenShare()`, tag/clear pending streams, reset source on host migration.
5. WebRTC perfect negotiation, uncaught promise handling, tile cleanup.
6. Memory/array caps and deployment config (`engines`, healthcheck, always-on plan).
