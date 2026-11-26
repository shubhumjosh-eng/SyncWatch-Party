# Fix plan — SyncWatch Party bug review

## Phase 1 — Server and test harness
- Add range support to `serveFile()` (206, `Accept-Ranges`, `Content-Range`).
- Export the HTTP server for `node:test`; only listen when run directly.
- Generate server-side client IDs; ignore client-supplied IDs.
- Add `leaveRoom()` with host migration, presence/state broadcast, stale mapping cleanup.
- Validate room codes and all incoming WS messages; add `maxPayload`, rate limits, Origin check.
- Persist and replay `room.mediaSource` on join/state request.
- Validate cross-room RTC targeting and send peer-left RTC events.
- Add `engines.node >=18`, healthcheck config, and tests.

## Phase 2 — Isolated client modules (parallel)
- `ffmpegWorker.js`: serialized job queue, per-job filenames, `finally` cleanup, load retry, CORS-safe fetch, safer concat.
- `rtcCall.js`: perfect negotiation, SDP/ICE validation, promise handling, bounded `pendingIce`, full track cleanup.
- `telestrator.js`: validate/bound strokes, points, coordinates, width, and color.

## Phase 3 — App integration
- Use server-assigned client ID; guard WebSocket reconnect/duplicate JOIN.
- Fix screen-share lifecycle, `stopScreenShare()` guard, pending stream tagging, host-change source reset.
- Apply late-joiner `mediaSource`; clamp guest playback target to duration/readiness.
- Fix call tile cleanup, remote autoplay/muting, real reel duration label.
- Cap memory arrays, revoke object URLs, fix seek slider state.
- Make clipping honest for local/screen sources (host-only with clear guest notice).

## Phase 4 — Verify
- `node --test` for server behavior.
- Syntax checks for all JS.
- Live two-tab Playwright QA: seeking, timestamp chat, sync, host migration, clipping, stitch, console errors.
- Commit, push, redeploy, re-run smoke QA.
