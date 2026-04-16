package emotes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// newBundleServer serves stub responses for every endpoint hit by a Fetcher
// against a single channel. Paths that don't match return 500 so the test
// notices unexpected requests.
func newBundleServer(t *testing.T, callCount *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(callCount, 1)
		switch {
		case r.URL.Path == "/helix/chat/emotes/global":
			fmt.Fprint(w, twitchGlobalEmotesBody)
		case r.URL.Path == "/helix/chat/emotes":
			fmt.Fprint(w, `{"data":[],"template":""}`)
		case r.URL.Path == "/helix/chat/badges/global":
			fmt.Fprint(w, `{"data":[{"set_id":"moderator","versions":[{"id":"1","image_url_1x":"https://u/1"}]}]}`)
		case r.URL.Path == "/helix/chat/badges":
			fmt.Fprint(w, `{"data":[]}`)
		case r.URL.Path == "/7tv/emote-sets/global":
			fmt.Fprint(w, sevenTVSampleSet)
		case r.URL.Path == "/7tv/users/twitch/42":
			w.WriteHeader(http.StatusNotFound)
		case r.URL.Path == "/bttv/cached/emotes/global":
			fmt.Fprint(w, `[{"id":"a","code":"G","imageType":"png"}]`)
		case r.URL.Path == "/bttv/cached/users/twitch/42":
			fmt.Fprint(w, `{"channelEmotes":[{"id":"c","code":"C","imageType":"png"}],"sharedEmotes":[]}`)
		case r.URL.Path == "/ffz/set/global":
			fmt.Fprint(w, `{"default_sets":[1],"sets":{"1":{"emoticons":[{"id":1,"name":"G","urls":{"1":"//cdn/x"}}]}}}`)
		case r.URL.Path == "/ffz/room/id/42":
			fmt.Fprint(w, `{"sets":{"2":{"emoticons":[{"id":2,"name":"C","urls":{"1":"//cdn/y"}}]}}}`)
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
}

func TestFetcher_AllProviders(t *testing.T) {
	var calls int32
	srv := newBundleServer(t, &calls)
	defer srv.Close()

	f := &Fetcher{
		Twitch:  &TwitchClient{HTTPClient: srv.Client(), BaseURL: srv.URL + "/helix", ClientID: "cid", AccessToken: "tok"},
		SevenTV: &SevenTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL + "/7tv"},
		BTTV:    &BTTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL + "/bttv"},
		FFZ:     &FFZClient{HTTPClient: srv.Client(), BaseURL: srv.URL + "/ffz"},
	}

	b := f.Fetch(context.Background(), "42")

	// 4 Twitch + 2 SevenTV + 2 BTTV + 2 FFZ = 10 requests.
	if got := atomic.LoadInt32(&calls); got != 10 {
		t.Errorf("requests = %d, want 10", got)
	}
	// SevenTV channel is 404 — absorbed as "not configured", not an error.
	if len(b.Errors) != 0 {
		t.Errorf("errors: %+v", b.Errors)
	}
	if len(b.TwitchGlobalEmotes.Emotes) == 0 {
		t.Error("twitch global emotes empty")
	}
	if b.TwitchGlobalBadges.Badges[0].Set != "moderator" {
		t.Errorf("twitch badge: %+v", b.TwitchGlobalBadges)
	}
	if len(b.SevenTVChannel.Emotes) != 0 {
		t.Errorf("seventv channel should be empty on 404, got %+v", b.SevenTVChannel)
	}
	if b.BTTVChannel.Emotes[0].Code != "C" {
		t.Errorf("bttv channel: %+v", b.BTTVChannel)
	}
	if b.FFZChannel.Emotes[0].Code != "C" {
		t.Errorf("ffz channel: %+v", b.FFZChannel)
	}
}

func TestFetcher_NilProvidersSkipped(t *testing.T) {
	f := &Fetcher{}
	b := f.Fetch(context.Background(), "42")
	if len(b.Errors) != 0 {
		t.Errorf("errors: %+v", b.Errors)
	}
	if len(b.TwitchGlobalEmotes.Emotes) != 0 || len(b.BTTVGlobal.Emotes) != 0 {
		t.Error("nothing should be fetched when all clients are nil")
	}
}

func TestFetcher_RecordsProviderErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	f := &Fetcher{BTTV: &BTTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}}
	b := f.Fetch(context.Background(), "42")
	if len(b.Errors) != 2 {
		t.Fatalf("errors = %d, want 2 (global + channel both 502)", len(b.Errors))
	}
	for _, e := range b.Errors {
		if e.Provider != ProviderBTTV {
			t.Errorf("provider = %s", e.Provider)
		}
	}
}
