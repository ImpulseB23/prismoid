# Stability and Error Handling

## Connection Resilience

All platform connections use automatic reconnect with exponential backoff and jitter.

| Parameter | Value |
|---|---|
| Initial backoff | 1 second |
| Max backoff | 30 seconds |
| Backoff multiplier | 2x |
| Jitter | +/- 25% |
| Max retries | Unlimited (connections are always retried) |

No visible "disconnected" state in the UI. A subtle indicator appears during reconnection, auto-dismissed on success.

### Platform Isolation

Each platform connection is independent. A Twitch disconnection does not affect YouTube, and vice versa. Kick (Phase 5) is fully isolated with its own goroutine and error handling.

If one platform fails to connect on startup, the others still work. The failed platform retries in the background.

## Sidecar Health

Rust monitors the Go sidecar via heartbeats over the stdio control plane.

- Heartbeat interval: 1 second
- Threshold: 3 missed heartbeats triggers respawn
- On crash: Rust respawns Go within seconds. A few messages may be missed during the gap
- The app itself never crashes due to sidecar failure

## Rust Panic Handling

Every Rust processing path catches panics. A malformed message from any platform is logged and skipped, never causes a crash.

```
catch_unwind on message processing
    |
    Ok(message) -> continue pipeline
    |
    Err(panic) -> log error, skip message, continue
```

## Defensive Parsing

All incoming data from platform APIs is parsed defensively:

- Unknown fields are ignored (forward compatibility)
- Missing optional fields use defaults
- Malformed messages are logged and dropped
- The app must survive any payload any platform sends, including garbage data

No `unwrap()` on external data. All platform data goes through `Result`-returning parsers.

## SQLite Durability

Writes are async and batched. The UI never blocks on disk I/O.

If the app crashes before a flush:
- Emote cache may be slightly stale (re-fetched on next launch)
- User preferences from the last few seconds may be lost
- No data corruption (WAL mode handles crash recovery)
- No user action required

## Graceful Degradation

| Failure | Impact | Recovery |
|---|---|---|
| Twitch disconnects | YouTube chat still works | Auto-reconnect with backoff |
| YouTube disconnects | Twitch chat still works | Auto-reconnect with backoff |
| Go sidecar crashes | All connections lost briefly | Rust respawns within seconds |
| 7TV API unreachable | 7TV emotes show as text | Retry on next refresh interval (5 min) |
| OAuth token expired | Platform auth fails | Proactive refresh prevents this; if refresh fails, prompt re-auth |
| SQLite write fails | Cache stale | Retry on next batch; app still works from memory |
| Emote image 404 | Single emote shows as text | Logged, removed from cache |
