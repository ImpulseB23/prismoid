# Frontend Architecture

## Stack

- **Framework**: SolidJS (fine-grained signals, no virtual DOM)
- **Language**: TypeScript (strict mode)
- **Text measurement**: Pretext (`@chenglou/pretext`) for DOM-free layout computation
- **Build**: Vite
- **Testing**: Vitest + `@solidjs/testing-library` (unit/component), WebdriverIO + tauri-driver (E2E)

## State Management

Built-in Solid signals organized into domain modules. No external state management library.

### Domain Modules

Each module exports signals and mutation functions. Modules live in `src/stores/`.

- `chatStore` - message buffer access, viewport position, scroll state
- `connectionStore` - per-platform connection status, reconnection state
- `settingsStore` - user preferences, theme, layout
- `emoteStore` - emote picker state, recent/favorites, search
- `modStore` - mod permissions per platform, pending actions
- `authStore` - linked accounts, auth status per platform

### Message Buffer (outside reactivity)

The message buffer is a plain TypeScript ring buffer, not a Solid store. At 10k+ msg/sec, reactive tracking per message is wasteful.

```
Messages arrive (batched per frame from Rust IPC)
    |
    v
Write to ring buffer (plain TS, no reactivity)
    |
    v
Update viewport signal (one signal, once per frame)
    |
    v
Virtual scroller reads visible slice from buffer
    |
    v
Solid renders only the visible ~80 DOM nodes
```

The viewport signal contains a start index and count. The virtual scroller component reads the signal and pulls messages directly from the ring buffer by index.

## Virtual Scrolling

### Layout Computation

1. Message arrives with text content and emote positions
2. Pretext measures text segments (between emotes/badges)
3. Emotes and badges are fixed-width inline boxes (dimensions known from emote metadata)
4. Total line width = sum of text segment widths + inline box widths
5. Line wrapping computed from total widths vs container width
6. Message height = number of lines * line height + padding
7. Heights stored in a parallel array indexed by buffer position

### DOM Management

- Only visible messages + a small buffer above and below exist in the DOM (~80 nodes max)
- Container has `will-change: transform` for GPU compositing
- Messages positioned via `transform: translateY()` based on cumulative height
- On scroll, calculate which buffer indices are visible, update the viewport signal

### Frame Budget at Volume

At 5,000+ msg/sec:
1. All messages arriving within one 16ms frame land in the ring buffer
2. Heights are pre-computed for all of them
3. Only the most recent ~80-100 are candidates for live rendering
4. If the user is scrolled to bottom, viewport shifts to show newest messages
5. If the user is scrolled up (reading backlog), new messages enter the buffer silently without disturbing scroll position
6. Skipped messages are in the buffer for scroll-back, just never appeared on screen live

## Emote Rendering

### Static Emotes

Standard `<img>` tags. Browser image cache handles deduplication. `createImageBitmap()` for off-main-thread decode on first encounter. Lazy-loaded on viewport entry.

### Animated Emotes

One `OffscreenCanvas` per unique animated emote, running on a shared web worker. All instances of the same emote reference the same canvas output. Shared animation timer across all animated emotes.

Paused when out of viewport. If profiling shows worker transfer overhead exceeds savings, falls back to native `<img>` with animated WebP/GIF.

### Emote Picker

1. Search bar at top with fuzzy search across all providers
2. Recent/favorites section
3. Categorized tabs: 7TV, BTTV, FFZ, native Twitch, native YouTube
4. Virtual grid for the emote list (lazy-load images on scroll)

## Optimistic UI

### Mod Actions

1. User clicks ban/timeout/delete
2. UI updates immediately: message grayed out, strikethrough, action button disabled
3. Tauri IPC sends action to Rust
4. On success: no UI change needed (already updated)
5. On failure: revert UI, show brief error indicator

### Sending Messages

1. User sends message
2. Message appended to chat at lower opacity
3. On confirmation via platform event stream: promoted to full opacity
4. On failure: marked red with retry button

## Theming

CSS custom properties for all colors, spacing, and typography. Theme files are JSON objects mapping token names to values. Users can create and share themes.

## OBS Overlay

Local HTTP server (Rust, bound to `127.0.0.1`) serves a browser source page. The overlay page connects via WebSocket to receive the same message stream.

Platform indicators (Twitch/YouTube icons next to usernames) are stripped from the overlay. The overlay renders clean unified chat with no visible platform distinction.

A disclaimer is shown when enabling overlay export.
