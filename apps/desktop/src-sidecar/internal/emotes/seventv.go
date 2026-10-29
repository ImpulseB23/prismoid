package emotes

import (
	"context"
	"fmt"
)

// SevenTV endpoints. Override in tests via [SevenTVClient.BaseURL].
const sevenTVDefaultBase = "https://7tv.io/v3"

// SevenTVClient fetches emote sets from 7TV.
//
// Docs: https://7tv.io/docs/api/v3. Channels are addressed by the Twitch
// numeric user ID; 7TV resolves it to its own internal user and emote set.
type SevenTVClient struct {
	HTTPClient Doer
	BaseURL    string
}

// FetchGlobal returns the 7TV global emote set.
func (c *SevenTVClient) FetchGlobal(ctx context.Context) (EmoteSet, error) {
	var raw sevenTVEmoteSet
	if err := getJSON(ctx, c.client(), c.base()+"/emote-sets/global", &raw); err != nil {
		return EmoteSet{}, err
	}
	return EmoteSet{
		Provider: Provider7TV,
		Scope:    ScopeGlobal,
		Emotes:   raw.toEmotes(),
	}, nil
}

// FetchChannel returns the 7TV set attached to the given Twitch broadcaster.
// Returns [ErrNotFound] if the channel has no 7TV account linked.
func (c *SevenTVClient) FetchChannel(ctx context.Context, twitchUserID string) (EmoteSet, error) {
	var user sevenTVUser
	if err := getJSON(ctx, c.client(), c.base()+"/users/twitch/"+twitchUserID, &user); err != nil {
		return EmoteSet{}, err
	}
	return EmoteSet{
		Provider:  Provider7TV,
		Scope:     ScopeChannel,
		ChannelID: twitchUserID,
		Emotes:    user.EmoteSet.toChannelEmotes(),
	}, nil
}

// FetchUserID returns the 7TV account id linked to a Twitch user, or
// [ErrNotFound] when they have none.
func (c *SevenTVClient) FetchUserID(ctx context.Context, twitchUserID string) (string, error) {
	var conn struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := getJSON(ctx, c.client(), c.base()+"/users/twitch/"+twitchUserID, &conn); err != nil {
		return "", err
	}
	if conn.User.ID == "" {
		return "", ErrNotFound
	}
	return conn.User.ID, nil
}

// SendSelfPresence marks a 7TV user as present in a Twitch channel for one
// EventAPI session. Being passive, the user's cosmetics come back on that
// socket only and are not published to the rest of the channel. It is the
// call the 7TV extension makes on channel join (src/worker/worker.http.ts).
func (c *SevenTVClient) SendSelfPresence(ctx context.Context, sevenTVUserID, channelID, sessionID string) error {
	body := map[string]any{
		"kind":       1,
		"passive":    true,
		"session_id": sessionID,
		"data":       map[string]string{"platform": "TWITCH", "id": channelID},
	}
	return postJSON(ctx, c.client(), c.base()+"/users/"+sevenTVUserID+"/presences", body)
}

func (c *SevenTVClient) base() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return sevenTVDefaultBase
}

func (c *SevenTVClient) client() Doer {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return defaultHTTPClient
}

// sevenTVEmoteSet matches the JSON shape of `/emote-sets/{id}`.
type sevenTVEmoteSet struct {
	Emotes []sevenTVEmote `json:"emotes"`
}

type sevenTVUser struct {
	EmoteSet sevenTVEmoteSet `json:"emote_set"`
}

// sevenTVEmote is an entry inside an emote set's `emotes` array. The name
// at this level can override `data.name` (user-customized alias); we prefer
// the outer name to match what the chat text would contain. Timestamp
// (unix ms) and ActorID record when and by which 7TV user the emote was
// added to the set; ActorID is null on some old entries.
type sevenTVEmote struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Timestamp int64            `json:"timestamp"`
	ActorID   string           `json:"actor_id"`
	Data      sevenTVEmoteData `json:"data"`
}

type sevenTVEmoteData struct {
	Animated bool        `json:"animated"`
	Flags    int         `json:"flags"`
	Host     sevenTVHost `json:"host"`
	// Owner is missing on a few live emotes.
	Owner *struct {
		ID          string `json:"id"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
	} `json:"owner"`
}

type sevenTVHost struct {
	URL   string            `json:"url"`
	Files []sevenTVHostFile `json:"files"`
}

type sevenTVHostFile struct {
	Name   string `json:"name"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Format string `json:"format"`
}

// sevenTVFlagZeroWidth is the bit set on overlay emotes (cvMask etc.).
// 7TV source of truth: https://github.com/SevenTV/API/blob/main/data/model/emote.model.go
const sevenTVFlagZeroWidth = 1 << 8

func (s sevenTVEmoteSet) toEmotes() []Emote {
	out := make([]Emote, 0, len(s.Emotes))
	for _, e := range s.Emotes {
		if em, ok := e.toEmote(); ok {
			out = append(out, em)
		}
	}
	return out
}

// toChannelEmotes is toEmotes plus when and by whom each emote was added,
// which only means something for a channel's own set.
func (s sevenTVEmoteSet) toChannelEmotes() []Emote {
	out := make([]Emote, 0, len(s.Emotes))
	for _, e := range s.Emotes {
		em, ok := e.toEmote()
		if !ok {
			continue
		}
		em.AddedAt = e.Timestamp
		em.AddedByID = e.ActorID
		out = append(out, em)
	}
	return out
}

func (e sevenTVEmote) toEmote() (Emote, bool) {
	u1, u2, u4, w, h := pickSevenTVFiles(e.Data.Host)
	if u1 == "" {
		return Emote{}, false
	}
	em := Emote{
		ID:        e.ID,
		Code:      e.Name,
		Provider:  Provider7TV,
		URL1x:     u1,
		URL2x:     u2,
		URL4x:     u4,
		Width:     w,
		Height:    h,
		Animated:  e.Data.Animated,
		ZeroWidth: e.Data.Flags&sevenTVFlagZeroWidth != 0,
	}
	// The host's file list leaves out the still frames, but the CDN serves
	// them beside each size; BetterTTV's 7TV support uses the same names.
	if e.Data.Animated {
		em.Static1x = joinHost(e.Data.Host.URL, "1x_static.webp")
		em.Static2x = joinHost(e.Data.Host.URL, "2x_static.webp")
	}
	if o := e.Data.Owner; o != nil {
		em.Owner = newEmoteOwner(o.ID, o.Username, o.DisplayName)
	}
	return em, true
}

// pickSevenTVFiles selects the webp variants for 1x/2x/4x from the provider's
// file list. Width/height come from the 1x entry. Returns empty URL1x when
// the host has no usable files (malformed response).
func pickSevenTVFiles(h sevenTVHost) (u1, u2, u4 string, w, hpx int) {
	for _, f := range h.Files {
		if f.Format != "WEBP" {
			continue
		}
		switch f.Name {
		case "1x.webp":
			u1 = joinHost(h.URL, f.Name)
			w, hpx = f.Width, f.Height
		case "2x.webp":
			u2 = joinHost(h.URL, f.Name)
		case "4x.webp":
			u4 = joinHost(h.URL, f.Name)
		}
	}
	return
}

// joinHost builds a full URL from 7TV's protocol-relative host (`//cdn.7tv.app/...`)
// plus a file name.
func joinHost(host, name string) string {
	if host == "" || name == "" {
		return ""
	}
	if len(host) >= 2 && host[:2] == "//" {
		return "https:" + host + "/" + name
	}
	return fmt.Sprintf("%s/%s", host, name)
}
