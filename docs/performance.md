# Performance Requirements

These are requirements, not goals.

## Target Volumes

| Scenario | Messages/sec |
|---|---|
| Normal large streamer (30-50k viewers) | 200-500 |
| Top streamer regular stream (80-150k viewers) | 500-1,500 |
| Peak event, single platform | 5,000-10,000 |
| Peak event, all platforms combined | 10,000-20,000 |

## Memory Budget

Total target: under 80MB.

| Component | Budget |
|---|---|
| Tauri WebView | ~30MB |
| Go sidecar | ~15MB |
| Rust processing core | ~5-10MB |
| Emote caches | Variable (bounded by memory eviction) |

## Rendering Pipeline

### Virtual Scrolling

- Pretext (`@chenglou/pretext`) for DOM-free text measurement
- Only visible messages + small buffer exist in DOM. Never more than ~80 nodes
- Pretext measures text segments. Emotes and badges are fixed-width inline boxes with known dimensions from metadata
- Total message height = Pretext text measurement + inline box arithmetic

### Frame Batching

- All messages arriving within one 16ms frame are batched into a single `requestAnimationFrame` DOM update
- At 5,000+ msg/sec, only the most recent ~80-100 messages per frame tick are rendered live
- Skipped messages go to the scroll-back buffer (still accessible via scroll-up, just never rendered live)
- One Solid signal update per frame (viewport changed), not one per message

### GPU Layers

- Chat scroll container on its own GPU layer (`will-change: transform`)
- Input field on separate layer
- Max 2-3 promoted layers total
- No `box-shadow`, complex `border-radius`, or `filter` on message elements
- Transitions use `transform` and `opacity` only

### Message Buffer

The message buffer lives outside Solid's reactivity system. It's a plain TypeScript ring buffer (pre-allocated). The virtual scroller reads from it directly. A single Solid signal tracks the viewport window (which slice of the buffer is visible).

## Emote Optimization

### Decode

- One decode per unique emote. Browser image cache handles dedup
- `createImageBitmap()` for off-main-thread decode on first encounter
- Images lazy-loaded on viewport entry, cached in memory after first load

### Animation

- One `OffscreenCanvas` per unique animated emote, running on a web worker with a shared timer
- All instances of the same animated emote reference the same canvas
- Paused when out of viewport
- Fallback to `<img>` tags if profiling shows worker overhead exceeds savings

### Rust Emote Table

- Flat `Vec<EmoteEntry>` with `#[repr(C)]`, cache-line friendly for aho-corasick hot path
- Zero heap allocation per message on the hot path. Pre-allocated structs, allocation-free aho-corasick scan
- Automaton double-buffered: new automaton built on background thread, swapped atomically via `ArcSwap`

## Processing Pipeline

### Rust

- Zero heap allocation per message on hot path
- Pre-allocated structs reused across messages
- Allocation-free aho-corasick scan
- Batched IPC to frontend: one payload per frame, not one per message

### Go

- Pre-allocated WebSocket read buffers
- Reused HTTP clients
- TCP keepalive on all connections
- Token bucket rate limiter per platform API

## Startup

- Cold start under 2 seconds
- Window shows immediately with empty shell
- Rust hydrates from SQLite, Go connects to platforms, both concurrent
- First messages appear on first successful connection
- Emotes loaded from SQLite cache instantly, diffed against live APIs in background, hot-swapped silently
- No loading spinners for emotes

## Optimistic UI

- Mod actions: UI updates immediately on click (gray out, strikethrough). API call in background. Revert only on failure
- Sending messages: appended at lower opacity instantly. Promoted to full opacity when confirmed via platform event stream. Marked red with retry on failure
