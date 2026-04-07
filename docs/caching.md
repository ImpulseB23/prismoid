# Caching Strategy

## Cache Layers

| Layer | Location | Contents | Lifetime |
|---|---|---|---|
| Hot memory | Rust `HashMap`/`DashMap` | Emote code-to-URL mappings, badge metadata, aho-corasick automaton | While app is running or minimized to tray |
| SQLite | `~/.local/share/prismoid/cache.db` (Linux), `%APPDATA%/prismoid/cache.db` (Windows), `~/Library/Application Support/prismoid/cache.db` (macOS) | Emote set metadata, user preferences, window layout, account info, schema version | Persistent across launches |
| Filesystem | `~/.cache/prismoid/emotes/` (Linux), `%LOCALAPPDATA%/prismoid/cache/emotes/` (Windows) | Emote image files (WebP, AVIF, PNG, GIF) | Persistent, LRU eviction at 500MB |
| OS Keychain | Native per platform | OAuth access + refresh tokens | Persistent, never stored as plaintext |

No Redis. No external cache. Everything local.

## Chat Messages

Memory-only. Chat messages are never persisted to disk. When the stream ends (or the app closes fully), messages are gone. This is intentional for privacy and simplicity.

The frontend message buffer is a plain TypeScript ring buffer. Fixed capacity. When full, oldest messages are overwritten. Scroll-back is limited to buffer capacity.

## Emote Caching

### On Channel Join

1. Read emote metadata from SQLite (instant, cached from last visit)
2. Render UI with cached emotes immediately
3. Fetch fresh emote sets from all providers concurrently in background (7TV, BTTV, FFZ, native)
4. Diff against SQLite cache
5. If changed: update SQLite, rebuild aho-corasick automaton on background thread, swap atomically
6. Hot-swap emote images silently. No loading spinners, no flash of missing emotes

### Refresh Interval

- On channel join: immediate background diff
- While connected: every 5 minutes
- While idle (minimized to tray, no active stream): no refresh

### Image Cache

- Emote images stored on filesystem by emote ID and size
- LRU eviction when total cache exceeds 500MB
- `createImageBitmap()` for off-main-thread decode on first load
- In-memory reference held after first render, released on 30-minute idle timeout

### Global Emotes and Badges

- Global emote sets (7TV global, BTTV global, FFZ global, Twitch global) cached with 1-hour in-memory TTL
- Badge metadata cached with 1-hour in-memory TTL
- Both backed by SQLite for instant cold-start hydration

## SQLite

### Journal Mode

WAL (Write-Ahead Logging). Allows concurrent reads while async writes happen. UI never blocks on disk I/O.

### Write Strategy

Writes are async and batched. Multiple cache updates within a short window are coalesced into a single transaction. If the app crashes before a flush, the only cost is a few extra API calls on next launch to re-fetch what wasn't persisted.

### Schema Migrations

Embedded in the Rust binary from day one. On startup, the app checks the schema version and runs any pending migrations automatically. Users never interact with the database directly.

## OAuth Tokens

- Stored in OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service)
- Access token and refresh token stored per platform per account
- Proactive refresh: Go refreshes the access token 5 minutes before expiry
- If refresh fails (token revoked, API error): that platform degrades gracefully. Other platforms unaffected. UI shows a "re-authenticate" prompt for the failed platform
