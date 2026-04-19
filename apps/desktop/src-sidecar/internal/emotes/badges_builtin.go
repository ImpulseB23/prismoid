package emotes

// Built-in badge sets for platforms that don't expose a badge image API.
// YouTube semantic roles and Kick Pusher badge types resolve against these
// bundled SVG data URIs on the frontend. The {set, version} pairs here
// must match what the Rust parsers emit on each ChatMessage.

// YouTube badges. Role flags come from author_details on each
// LiveChatMessage; the Rust parser synthesizes {set_id, id} pairs that
// map 1:1 to these entries.
var youTubeBadges = BadgeSet{
	Scope: ScopeGlobal,
	Badges: []Badge{
		{Set: "youtube/owner", Version: "1", Title: "Channel Owner", URL1x: ytOwnerURI},
		{Set: "youtube/moderator", Version: "1", Title: "Moderator", URL1x: ytModeratorURI},
		{Set: "youtube/member", Version: "1", Title: "Member", URL1x: ytMemberURI},
	},
}

// Kick badges. The Pusher v2 payload carries badge type strings without
// image URLs; the Rust parser prefixes them with "kick/" and normalizes
// the version to "1" so they resolve here.
var kickBadges = BadgeSet{
	Scope: ScopeGlobal,
	Badges: []Badge{
		{Set: "kick/broadcaster", Version: "1", Title: "Broadcaster", URL1x: kickBroadcasterURI},
		{Set: "kick/moderator", Version: "1", Title: "Moderator", URL1x: kickModeratorURI},
		{Set: "kick/subscriber", Version: "1", Title: "Subscriber", URL1x: kickSubscriberURI},
		{Set: "kick/vip", Version: "1", Title: "VIP", URL1x: kickVIPURI},
	},
}

// Minimal SVG data URIs. Each is a recognizable icon at 18x18 matching
// the platform's brand color. SVGs scale cleanly so url_2x/url_4x are
// left empty; the frontend renders url_1x at the badge slot size.

// YouTube owner: wrench, #FFD600 (YouTube verified-owner gold).
const ytOwnerURI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath fill='%23FFD600' d='M14.4 3.6a4.5 4.5 0 00-6 .4L3.5 9l5.5 5.5 4.9-4.9a4.5 4.5 0 00.4-6l-2.7 2.7-1.8-1.8 2.6-2.9zM2 15.3l1.3 1.3 2-2-1.3-1.3-2 2z'/%3E%3C/svg%3E"

// YouTube moderator: wrench, #5E84F1 (YouTube moderator blue).
const ytModeratorURI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath fill='%235E84F1' d='M14.4 3.6a4.5 4.5 0 00-6 .4L3.5 9l5.5 5.5 4.9-4.9a4.5 4.5 0 00.4-6l-2.7 2.7-1.8-1.8 2.6-2.9zM2 15.3l1.3 1.3 2-2-1.3-1.3-2 2z'/%3E%3C/svg%3E"

// YouTube member: heart, #2BA640 (YouTube member green).
const ytMemberURI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath fill='%232BA640' d='M9 15.3l-1-1C4.1 11 2 9 2 6.6A3.7 3.7 0 015.7 3c1 0 2 .5 3.3 1.5C10 3.5 11 3 12.3 3A3.7 3.7 0 0116 6.6c0 2.4-2.1 4.4-6 7.7l-1 1z'/%3E%3C/svg%3E"

// Kick broadcaster: crown, #53FC18 (Kick green).
const kickBroadcasterURI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath fill='%2353FC18' d='M15 5l-3 3-3-4-3 4-3-3v8h12V5zM3 14h12v2H3v-2z'/%3E%3C/svg%3E"

// Kick moderator: shield, #53FC18 (Kick green).
const kickModeratorURI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath fill='%2353FC18' d='M9 1L3 4v5c0 4.2 2.6 8.1 6 9 3.4-.9 6-4.8 6-9V4L9 1z'/%3E%3C/svg%3E"

// Kick subscriber: star, #00D4FF (Kick subscriber blue).
const kickSubscriberURI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath fill='%2300D4FF' d='M9 1.5l2.5 5 5.5.8-4 3.9 1 5.6L9 14l-5 2.8 1-5.6-4-3.9 5.5-.8z'/%3E%3C/svg%3E"

// Kick VIP: diamond, #E69E04 (amber/gold).
const kickVIPURI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath fill='%23E69E04' d='M9 2L3 8l6 8 6-8L9 2z'/%3E%3C/svg%3E"
