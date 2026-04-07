# Moderation

## Actions

| Action          | Twitch                                         | YouTube                                         |
| --------------- | ---------------------------------------------- | ----------------------------------------------- |
| Delete message  | Helix `DELETE /moderation/chat`                | `liveChatMessages.delete`                       |
| Timeout         | Helix `POST /moderation/bans` with `duration`  | `liveChatBans.insert` with `banDurationSeconds` |
| Ban (permanent) | Helix `POST /moderation/bans` without duration | `liveChatBans.insert` without duration          |
| Unban           | Helix `DELETE /moderation/bans`                | `liveChatBans.delete`                           |

## Flow

```
User clicks mod button
    |
    v
Frontend updates UI optimistically (gray out, strikethrough)
    |
    v
Tauri IPC -> Rust (identifies platform from UnifiedMessage)
    |
    v
Rust routes to Go via command channel
    |
    v
Go dispatches to correct platform API
    |
    v
Success: no UI change needed (already updated)
Failure: Rust notifies frontend -> UI reverts, shows error indicator
```

## Permissions

On account link, the Go sidecar queries each platform's API to check the user's mod status for the connected channel.

- Twitch: Helix `GET /moderation/moderators` to check if user is mod
- YouTube: `liveChatModerators.list` to check if user is mod

Mod action buttons are only enabled for platforms where the user has permission. If the user is a mod on Twitch but not YouTube, Twitch messages show mod buttons and YouTube messages don't.

Permissions are re-checked on channel connect and cached for the session.

## User Cards

Click a username to open a user card:

- Display name and platform badge
- Account age (platform-specific)
- Follower/subscriber status
- Recent messages from this session (pulled from the message ring buffer by user ID)
- Quick-action buttons: timeout (with duration presets), ban, delete all messages from this user

User card data is fetched on demand from the platform API via Go, with a short cache (5 min) to avoid redundant calls when clicking the same user repeatedly.
