package emotes

// Built-in badge sets for platforms that don't expose a badge image API.
// YouTube semantic roles and Kick Pusher badge types resolve against these
// bundled SVG data URIs on the frontend. The {set, version} pairs here
// must match what the Rust parsers emit on each ChatMessage.

// YouTube badges. Role flags come from author_details on each
// LiveChatMessage; the Rust parser synthesizes {set_id, id} pairs that
// map 1:1 to these entries.
var youtubeBadges = BadgeSet{
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
const ytOwnerURI = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2018%2018'%3E%3Cpath%20fill='%23FFD600'%20d='M14.4%203.6a4.5%204.5%200%2000-6%20.4L3.5%209l5.5%205.5%204.9-4.9a4.5%204.5%200%2000.4-6l-2.7%202.7-1.8-1.8%202.6-2.9zM2%2015.3l1.3%201.3%202-2-1.3-1.3-2%202z'/%3E%3C/svg%3E"

// YouTube moderator: wrench, #5E84F1 (YouTube moderator blue).
const ytModeratorURI = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2018%2018'%3E%3Cpath%20fill='%235E84F1'%20d='M14.4%203.6a4.5%204.5%200%2000-6%20.4L3.5%209l5.5%205.5%204.9-4.9a4.5%204.5%200%2000.4-6l-2.7%202.7-1.8-1.8%202.6-2.9zM2%2015.3l1.3%201.3%202-2-1.3-1.3-2%202z'/%3E%3C/svg%3E"

// YouTube member: heart, #2BA640 (YouTube member green).
const ytMemberURI = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2018%2018'%3E%3Cpath%20fill='%232BA640'%20d='M9%2015.3l-1-1C4.1%2011%202%209%202%206.6A3.7%203.7%200%20015.7%203c1%200%202%20.5%203.3%201.5C10%203.5%2011%203%2012.3%203A3.7%203.7%200%200116%206.6c0%202.4-2.1%204.4-6%207.7l-1%201z'/%3E%3C/svg%3E"

// Kick broadcaster: crown, #53FC18 (Kick green).
const kickBroadcasterURI = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2018%2018'%3E%3Cpath%20fill='%2353FC18'%20d='M15%205l-3%203-3-4-3%204-3-3v8h12V5zM3%2014h12v2H3v-2z'/%3E%3C/svg%3E"

// Kick moderator: shield, #53FC18 (Kick green).
const kickModeratorURI = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2018%2018'%3E%3Cpath%20fill='%2353FC18'%20d='M9%201L3%204v5c0%204.2%202.6%208.1%206%209%203.4-.9%206-4.8%206-9V4L9%201z'/%3E%3C/svg%3E"

// Kick subscriber: star, #00D4FF (Kick subscriber blue).
const kickSubscriberURI = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2018%2018'%3E%3Cpath%20fill='%2300D4FF'%20d='M9%201.5l2.5%205%205.5.8-4%203.9%201%205.6L9%2014l-5%202.8%201-5.6-4-3.9%205.5-.8z'/%3E%3C/svg%3E"

// Kick VIP: diamond, #E69E04 (amber/gold).
const kickVIPURI = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2018%2018'%3E%3Cpath%20fill='%23E69E04'%20d='M9%202L3%208l6%208%206-8L9%202z'/%3E%3C/svg%3E"
