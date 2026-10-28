package emotes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBTTV_FetchGlobal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cached/emotes/global" {
			t.Fatalf("path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`[
			{"id":"abc","code":"PogU","imageType":"gif","animated":true,"width":28,"height":28,"userId":"5561169bd6b9d206222a8c19"},
			{"id":"def","code":"monkaS","imageType":"png","animated":false,"width":32,"height":32},
			{"id":"","code":"skipMe"}
		]`))
	}))
	defer srv.Close()

	c := &BTTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	set, err := c.FetchGlobal(context.Background())
	if err != nil {
		t.Fatalf("FetchGlobal: %v", err)
	}
	if len(set.Emotes) != 2 {
		t.Fatalf("emotes = %d, want 2", len(set.Emotes))
	}
	pog := set.Emotes[0]
	if pog.Code != "PogU" || !pog.Animated || pog.Owner != nil {
		t.Errorf("pog: %+v", pog)
	}
	if pog.URL1x != "https://cdn.betterttv.net/emote/abc/1x.gif" {
		t.Errorf("URL1x = %q", pog.URL1x)
	}
	if pog.URL4x != "https://cdn.betterttv.net/emote/abc/3x.gif" {
		t.Errorf("URL4x = %q", pog.URL4x)
	}
}

func TestBTTV_FetchChannel_MergesSharedAndChannel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cached/users/twitch/42" {
			t.Fatalf("path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{
			"id":"555943515393e61c772ee968",
			"channelEmotes":[{"id":"c1","code":"C1","imageType":"png","userId":"555943515393e61c772ee968"}],
			"sharedEmotes":[
				{"id":"s1","code":"S1","imageType":"png","user":{"id":"5561169bd6b9d206222a8c19","name":"nightdev","displayName":"NightDev","providerId":"29045896"}},
				{"id":"s2","code":"S2","imageType":"png","user":{"id":"u2","name":"lowercase","displayName":"","providerId":"1"}}
			]
		}`))
	}))
	defer srv.Close()

	c := &BTTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	set, err := c.FetchChannel(context.Background(), "42")
	if err != nil {
		t.Fatalf("FetchChannel: %v", err)
	}
	if set.ChannelID != "42" || set.Scope != ScopeChannel {
		t.Errorf("bad set: %+v", set)
	}
	if len(set.Emotes) != 3 {
		t.Fatalf("emotes = %d, want 3", len(set.Emotes))
	}
	if set.Emotes[0].Owner != nil {
		t.Errorf("channel upload owner = %+v, want nil", set.Emotes[0].Owner)
	}
	want := EmoteOwner{ID: "5561169bd6b9d206222a8c19", Login: "nightdev", DisplayName: "NightDev"}
	if o := set.Emotes[1].Owner; o == nil || *o != want {
		t.Errorf("shared owner = %+v", o)
	}
	if o := set.Emotes[2].Owner; o == nil || o.DisplayName != "lowercase" {
		t.Errorf("display name fallback = %+v", o)
	}
}

func TestBTTV_FetchChannel_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := &BTTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	_, err := c.FetchChannel(context.Background(), "0")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
