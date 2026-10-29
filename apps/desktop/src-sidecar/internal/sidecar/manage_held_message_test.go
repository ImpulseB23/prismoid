package sidecar

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
)

func heldMessageCmd(action string, requestID uint64) control.Command {
	return control.Command{
		Cmd:           "manage_held_message",
		BroadcasterID: "b1",
		UserID:        "u1",
		ClientID:      "cid",
		Token:         "tok",
		MessageID:     "held-1",
		Action:        action,
		RequestID:     requestID,
	}
}

func TestDispatchCommand_RoutesManageHeldMessage(t *testing.T) {
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/moderation/automod/message" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.String())
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	prev := twitchHelixBase
	twitchHelixBase = srv.URL
	defer func() { twitchHelixBase = prev }()
	notify, msgTypes, payloads := captureNotify()

	DispatchCommand(context.Background(), heldMessageCmd("ALLOW", 11), map[string]context.CancelFunc{}, idleSession(t), idleFirsts(), idleCosmetics(t), idleBundles(), make(chan []byte, 1), notify, zerolog.Nop())

	if len(*msgTypes) != 1 || (*msgTypes)[0] != "mod_action_result" {
		t.Fatalf("expected mod_action_result, got %#v", *msgTypes)
	}
	if !(*payloads)[0].Ok || (*payloads)[0].RequestID != 11 {
		t.Fatalf("unexpected payload: %+v", (*payloads)[0])
	}
	if body["user_id"] != "u1" || body["msg_id"] != "held-1" || body["action"] != "ALLOW" {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestHandleManageHeldMessage_RejectsMissingFields(t *testing.T) {
	notify, _, payloads := captureNotify()
	HandleManageHeldMessage(context.Background(), control.Command{Cmd: "manage_held_message", BroadcasterID: "b1"}, notify, zerolog.Nop())

	cmd := heldMessageCmd("DENY", 12)
	cmd.MessageID = ""
	HandleManageHeldMessage(context.Background(), cmd, notify, zerolog.Nop())

	cmd = heldMessageCmd("maybe", 13)
	HandleManageHeldMessage(context.Background(), cmd, notify, zerolog.Nop())

	if len(*payloads) != 3 {
		t.Fatalf("expected three replies, got %#v", *payloads)
	}
	for _, p := range *payloads {
		if p.Ok {
			t.Fatalf("expected failure, got %+v", p)
		}
	}
}

func TestHandleManageHeldMessage_ReportsHelixError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"Not Found","status":404,"message":"message not found"}`))
	}))
	defer srv.Close()

	prev := twitchHelixBase
	twitchHelixBase = srv.URL
	defer func() { twitchHelixBase = prev }()
	notify, _, payloads := captureNotify()

	HandleManageHeldMessage(context.Background(), heldMessageCmd("DENY", 14), notify, zerolog.Nop())

	if len(*payloads) != 1 {
		t.Fatalf("unexpected payloads: %#v", *payloads)
	}
	got := (*payloads)[0]
	if got.Ok || got.HTTPStatus != http.StatusNotFound || got.RequestID != 14 {
		t.Fatalf("unexpected payload: %+v", got)
	}
}
