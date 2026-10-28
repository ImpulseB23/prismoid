package emotes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const sevenTVSampleSet = `{
  "emotes": [
    {
      "id": "60ae958e229664e8667aea38",
      "name": "PepegaAim",
      "timestamp": 1653443428000,
      "actor_id": null,
      "data": {
        "animated": true,
        "flags": 256,
        "host": {
          "url": "//cdn.7tv.app/emote/60ae958e229664e8667aea38",
          "files": [
            {"name": "1x.webp", "width": 32, "height": 32, "format": "WEBP"},
            {"name": "2x.webp", "width": 64, "height": 64, "format": "WEBP"},
            {"name": "4x.webp", "width": 128, "height": 128, "format": "WEBP"},
            {"name": "1x.avif", "width": 32, "height": 32, "format": "AVIF"}
          ]
        },
        "owner": {
          "id": "01F6MTQK0R0000QWQEJTQA0MJ7",
          "username": "bodybuffalo28",
          "display_name": "BodyBuffalo28",
          "avatar_url": "https://static-cdn.jtvnw.net/x.png",
          "style": {},
          "role_ids": [],
          "connections": []
        }
      }
    },
    {
      "id": "bad",
      "name": "Broken",
      "data": {"host": {"url": "//cdn.7tv.app/emote/bad", "files": []}}
    }
  ]
}`

func TestSevenTV_FetchGlobal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/emote-sets/global" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(sevenTVSampleSet))
	}))
	defer srv.Close()

	c := &SevenTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	set, err := c.FetchGlobal(context.Background())
	if err != nil {
		t.Fatalf("FetchGlobal: %v", err)
	}
	if set.Provider != Provider7TV || set.Scope != ScopeGlobal {
		t.Errorf("wrong provider/scope: %+v", set)
	}
	if len(set.Emotes) != 1 {
		t.Fatalf("emotes = %d, want 1 (broken entry filtered)", len(set.Emotes))
	}
	e := set.Emotes[0]
	if e.Code != "PepegaAim" || !e.Animated || !e.ZeroWidth {
		t.Errorf("unexpected emote: %+v", e)
	}
	if e.URL1x != "https://cdn.7tv.app/emote/60ae958e229664e8667aea38/1x.webp" {
		t.Errorf("URL1x = %q", e.URL1x)
	}
	if e.URL4x == "" {
		t.Error("URL4x missing")
	}
	if e.Width != 32 || e.Height != 32 {
		t.Errorf("dims = %dx%d, want 32x32", e.Width, e.Height)
	}
	want := EmoteOwner{ID: "01F6MTQK0R0000QWQEJTQA0MJ7", Login: "bodybuffalo28", DisplayName: "BodyBuffalo28"}
	if e.Owner == nil || *e.Owner != want {
		t.Errorf("owner = %+v", e.Owner)
	}
	if e.AddedAt != 0 || e.AddedByID != "" {
		t.Errorf("global emote has added fields: %d %q", e.AddedAt, e.AddedByID)
	}
}

func TestSevenTV_OwnerFallbacks(t *testing.T) {
	var set sevenTVEmoteSet
	files := `"host":{"url":"//cdn.7tv.app/emote/x","files":[{"name":"1x.webp","format":"WEBP"}]}`
	raw := `{"emotes":[
		{"id":"a","name":"NoName","data":{` + files + `,"owner":{"id":"01FD0D0E5800048TJ1B00V3DRD","username":"mzntori","display_name":""}}},
		{"id":"b","name":"Blank","data":{` + files + `,"owner":{"id":"01FD0D0E5800048TJ1B00V3DRD","username":"","display_name":""}}},
		{"id":"c","name":"Null","data":{` + files + `,"owner":null}}
	]}`
	if err := json.Unmarshal([]byte(raw), &set); err != nil {
		t.Fatal(err)
	}
	got := set.toEmotes()
	if len(got) != 3 {
		t.Fatalf("emotes = %d", len(got))
	}
	if o := got[0].Owner; o == nil || o.DisplayName != "mzntori" || o.Login != "mzntori" {
		t.Errorf("display name fallback: %+v", o)
	}
	if got[1].Owner != nil || got[2].Owner != nil {
		t.Errorf("want no owner: %+v %+v", got[1].Owner, got[2].Owner)
	}
}

func TestSevenTV_FetchChannel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/users/twitch/12345" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"emote_set":` + sevenTVSampleSet + `}`))
	}))
	defer srv.Close()

	c := &SevenTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	set, err := c.FetchChannel(context.Background(), "12345")
	if err != nil {
		t.Fatalf("FetchChannel: %v", err)
	}
	if set.Scope != ScopeChannel || set.ChannelID != "12345" {
		t.Errorf("wrong scope/channel: %+v", set)
	}
	if len(set.Emotes) != 1 {
		t.Fatalf("emotes = %d, want 1", len(set.Emotes))
	}
	if e := set.Emotes[0]; e.AddedAt != 1653443428000 || e.AddedByID != "" {
		t.Errorf("added = %d %q", e.AddedAt, e.AddedByID)
	}
}

func sevenTVSetEntry(id, actor string, ts int64) string {
	actorJSON := "null"
	if actor != "" {
		actorJSON = `"` + actor + `"`
	}
	return fmt.Sprintf(`{"id":%q,"name":%q,"timestamp":%d,"actor_id":%s,"data":{"host":{"url":"//cdn.7tv.app/emote/%s","files":[{"name":"1x.webp","format":"WEBP"}]}}}`, id, id, ts, actorJSON, id)
}

func TestSevenTV_FetchChannelAdded(t *testing.T) {
	set := `{"emote_set":{"emotes":[` + strings.Join([]string{
		sevenTVSetEntry("a", "01FE9DRF000009TR6M9N941CYW", 1622025395000),
		sevenTVSetEntry("b", "", 1653443428000),
	}, ",") + `]}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/users/twitch/71092938" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(set))
	}))
	defer srv.Close()

	c := &SevenTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	got, err := c.FetchChannel(context.Background(), "71092938")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Emotes) != 2 {
		t.Fatalf("emotes = %d", len(got.Emotes))
	}
	if e := got.Emotes[0]; e.AddedAt != 1622025395000 || e.AddedByID != "01FE9DRF000009TR6M9N941CYW" {
		t.Errorf("a: %d %q", e.AddedAt, e.AddedByID)
	}
	if e := got.Emotes[1]; e.AddedAt != 1653443428000 || e.AddedByID != "" {
		t.Errorf("null actor: %d %q", e.AddedAt, e.AddedByID)
	}
}

func TestSevenTV_FetchChannel_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := &SevenTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	_, err := c.FetchChannel(context.Background(), "999")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestSevenTV_FetchUserID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/users/twitch/71092938":
			_, _ = w.Write([]byte(`{"id":"71092938","platform":"TWITCH","username":"xqc","user":{"id":"01FE9DRF000009TR6M9N941CYW","style":{"color":-1857617921,"paint_id":"01JHXJFACX42RV996VE9933TB8"}}}`))
		case "/users/twitch/1":
			_, _ = w.Write([]byte(`{"id":"1","user":{}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := &SevenTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	id, err := c.FetchUserID(context.Background(), "71092938")
	if err != nil || id != "01FE9DRF000009TR6M9N941CYW" {
		t.Fatalf("id %q err %v", id, err)
	}
	for _, missing := range []string{"1", "2"} {
		if _, err := c.FetchUserID(context.Background(), missing); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s: err = %v, want ErrNotFound", missing, err)
		}
	}
}

func TestSevenTV_SendSelfPresenceError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content type %q", r.Header.Get("Content-Type"))
		}
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":"bad session"}`))
	}))
	defer srv.Close()

	c := &SevenTVClient{HTTPClient: srv.Client(), BaseURL: srv.URL}
	err := c.SendSelfPresence(context.Background(), "stv", "42", "s")
	if err == nil || !strings.Contains(err.Error(), "status 422") {
		t.Fatalf("err = %v", err)
	}
	c.BaseURL = "http://127.0.0.1:1"
	if err := c.SendSelfPresence(context.Background(), "stv", "42", "s"); err == nil {
		t.Fatal("expected a connection error")
	}
}
