package sidecar

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
)

func TestHandleClearChat_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/moderation/chat" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.String())
		}
		q := r.URL.Query()
		if q.Get("broadcaster_id") != "b1" || q.Get("moderator_id") != "u1" || q.Has("message_id") {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	prev := twitchHelixBase
	twitchHelixBase = srv.URL
	defer func() { twitchHelixBase = prev }()
	notify, msgTypes, payloads := captureNotify()

	HandleClearChat(context.Background(), control.Command{
		Cmd:           "clear_chat",
		BroadcasterID: "b1",
		UserID:        "u1",
		ClientID:      "cid",
		Token:         "tok",
		RequestID:     7,
	}, notify, zerolog.Nop())

	if len(*msgTypes) != 1 || (*msgTypes)[0] != "mod_action_result" {
		t.Fatalf("expected mod_action_result, got %#v", *msgTypes)
	}
	if len(*payloads) != 1 || !(*payloads)[0].Ok || (*payloads)[0].RequestID != 7 {
		t.Fatalf("unexpected payloads: %#v", *payloads)
	}
}

func TestHandleClearChat_RejectsMissingAuth(t *testing.T) {
	notify, _, payloads := captureNotify()
	HandleClearChat(context.Background(), control.Command{Cmd: "clear_chat", BroadcasterID: "b1"}, notify, zerolog.Nop())
	if len(*payloads) != 1 || (*payloads)[0].Ok {
		t.Fatalf("unexpected payloads: %#v", *payloads)
	}
}

func TestHandleClearChat_ReportsHelixError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Forbidden","status":403,"message":"not a moderator"}`))
	}))
	defer srv.Close()

	prev := twitchHelixBase
	twitchHelixBase = srv.URL
	defer func() { twitchHelixBase = prev }()
	notify, _, payloads := captureNotify()

	HandleClearChat(context.Background(), control.Command{
		Cmd:           "clear_chat",
		BroadcasterID: "b1",
		UserID:        "u1",
		ClientID:      "cid",
		Token:         "tok",
		RequestID:     8,
	}, notify, zerolog.Nop())

	if len(*payloads) != 1 {
		t.Fatalf("unexpected payloads: %#v", *payloads)
	}
	got := (*payloads)[0]
	if got.Ok || got.HTTPStatus != http.StatusForbidden || got.RequestID != 8 {
		t.Fatalf("unexpected payload: %+v", got)
	}
}
