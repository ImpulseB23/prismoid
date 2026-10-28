package twitch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func testHelix(base, token, clientID string) *HelixClient {
	return &HelixClient{BaseURL: base, ClientID: clientID, AccessToken: token}
}

func TestDeleteSubscription(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(context.Background())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	if err := DeleteSubscription(context.Background(), testHelix(srv.URL, "tok", "cid"), "sub 1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Method != http.MethodDelete || got.URL.Path != "/eventsub/subscriptions" || got.URL.Query().Get("id") != "sub 1" {
		t.Fatalf("unexpected request %s %s", got.Method, got.URL)
	}
}

func TestSubscribeSuccess(t *testing.T) {
	var gotTypes []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/eventsub/subscriptions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("bad auth header: %s", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Client-Id") != "test-client" {
			t.Fatalf("bad client-id: %s", r.Header.Get("Client-Id"))
		}

		var req SubscriptionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		gotTypes = append(gotTypes, req.Type)
		if req.Version != "1" || req.Condition["broadcaster_user_id"] != "broadcaster-1" || req.Condition["user_id"] != "user-1" {
			t.Fatalf("unexpected request: %+v", req)
		}
		if req.Transport.SessionID != "sess-123" {
			t.Fatalf("unexpected session_id: %s", req.Transport.SessionID)
		}

		w.WriteHeader(http.StatusAccepted)
		_, _ = fmt.Fprintf(w, `{"data":[{"id":"sub-%d","status":"enabled"}]}`, len(gotTypes))
	}))
	defer srv.Close()

	ids, err := Subscribe(context.Background(), testHelix(srv.URL, "test-token", "test-client"), "sess-123", "broadcaster-1", "user-1")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if !slices.Equal(gotTypes, chatSubscriptions) {
		t.Fatalf("subscribed to %v, want %v", gotTypes, chatSubscriptions)
	}
	if !slices.Equal(ids, []string{"sub-1", "sub-2", "sub-3", "sub-4", "sub-5"}) {
		t.Fatalf("unexpected ids %v", ids)
	}
}

func TestSubscribeModerationUsesV2WithModeratorCondition(t *testing.T) {
	var got SubscriptionRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"data":[{"id":"mod-1","status":"enabled"}]}`))
	}))
	defer srv.Close()

	id, err := SubscribeModeration(context.Background(), testHelix(srv.URL, "tok", "cid"), "sess-1", "b-1", "m-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "mod-1" {
		t.Fatalf("unexpected id %q", id)
	}
	if got.Type != "channel.moderate" || got.Version != "2" {
		t.Fatalf("unexpected subscription: %+v", got)
	}
	if got.Condition["broadcaster_user_id"] != "b-1" || got.Condition["moderator_user_id"] != "m-1" {
		t.Fatalf("unexpected condition: %+v", got.Condition)
	}
	if got.Transport.SessionID != "sess-1" {
		t.Fatalf("unexpected session: %s", got.Transport.SessionID)
	}
}

func TestSubscribeModerationSurfacesForbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Forbidden","status":403,"message":"subscription missing proper authorization"}`))
	}))
	defer srv.Close()

	_, err := SubscribeModeration(context.Background(), testHelix(srv.URL, "tok", "cid"), "s", "b", "m")
	var he *HelixError
	if !errors.As(err, &he) || he.Status != http.StatusForbidden {
		t.Fatalf("expected 403 HelixError, got %v", err)
	}
}

func TestSubscribeAuthError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Unauthorized"}`))
	}))
	defer srv.Close()

	_, err := Subscribe(context.Background(), testHelix(srv.URL, "bad-token", "client"), "sess-123", "b", "u")
	if err == nil {
		t.Fatal("expected error")
	}

	var authErr *AuthError
	if !errors.As(err, &authErr) {
		t.Fatalf("expected AuthError, got %T: %v", err, err)
	}
	if authErr.Status != 401 {
		t.Fatalf("expected status 401, got %d", authErr.Status)
	}
}

func TestSubscribeForbiddenIsChatBan(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Forbidden","status":403,"message":"subscription missing proper authorization"}`))
	}))
	defer srv.Close()

	_, err := Subscribe(context.Background(), testHelix(srv.URL, "token", "client"), "sess-123", "b", "u")
	if !errors.Is(err, ErrChatBanned) {
		t.Fatalf("expected ErrChatBanned, got %v", err)
	}
	var denied *ChatAccessError
	if !errors.As(err, &denied) || denied.Status != http.StatusForbidden || !strings.Contains(denied.Body, "missing proper authorization") {
		t.Fatalf("unexpected error %v", err)
	}
	var authErr *AuthError
	if errors.As(err, &authErr) {
		t.Fatal("403 must not look like a token problem")
	}
}

func TestSubscribeServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"Internal Server Error"}`))
	}))
	defer srv.Close()

	_, err := Subscribe(context.Background(), testHelix(srv.URL, "token", "client"), "sess-123", "b", "u")
	if err == nil {
		t.Fatal("expected error for 500")
	}

	var authErr *AuthError
	if errors.As(err, &authErr) {
		t.Fatal("500 should not be an AuthError")
	}
}

func TestSendChatMessageSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/chat/messages" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var req SendChatMessageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if req.BroadcasterID != "b1" || req.SenderID != "u1" || req.Message != "hello" {
			t.Fatalf("unexpected body: %+v", req)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[{"message_id":"abc","is_sent":true}]}`))
	}))
	defer srv.Close()

	c := &HelixClient{BaseURL: srv.URL, ClientID: "cid", AccessToken: "tok"}
	resp, err := c.SendChatMessage(context.Background(), "b1", "u1", "hello", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Data) != 1 || !resp.Data[0].IsSent || resp.Data[0].MessageID != "abc" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestSendChatMessageDropped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[{"message_id":"","is_sent":false,"drop_reason":{"code":"msg_duplicate","message":"duplicate"}}]}`))
	}))
	defer srv.Close()

	c := &HelixClient{BaseURL: srv.URL, ClientID: "cid", AccessToken: "tok"}
	resp, err := c.SendChatMessage(context.Background(), "b1", "u1", "hello", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Data[0].IsSent {
		t.Fatal("expected dropped")
	}
	if resp.Data[0].DropReason.Code != "msg_duplicate" {
		t.Fatalf("unexpected drop code: %q", resp.Data[0].DropReason.Code)
	}
}

func TestSendChatMessageEmpty(t *testing.T) {
	c := &HelixClient{ClientID: "cid", AccessToken: "tok"}
	if _, err := c.SendChatMessage(context.Background(), "b1", "u1", "", ""); err == nil {
		t.Fatal("expected error for empty message")
	}
}

func TestSendChatMessageOversize(t *testing.T) {
	c := &HelixClient{ClientID: "cid", AccessToken: "tok"}
	big := make([]byte, MaxChatMessageBytes+1)
	for i := range big {
		big[i] = 'a'
	}
	if _, err := c.SendChatMessage(context.Background(), "b1", "u1", string(big), ""); err == nil {
		t.Fatal("expected error for oversized message")
	}
}

func TestSendChatMessageUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Unauthorized","status":401,"message":"Missing scope: user:write:chat"}`))
	}))
	defer srv.Close()

	c := &HelixClient{BaseURL: srv.URL, ClientID: "cid", AccessToken: "tok"}
	_, err := c.SendChatMessage(context.Background(), "b1", "u1", "hello", "")
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized, got %v", err)
	}
}

func TestBanUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/moderation/bans" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("broadcaster_id") != "b1" || q.Get("moderator_id") != "m1" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		var req banUserRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if req.Data.UserID != "u1" || req.Data.Reason != "spam" || req.Data.Duration != 0 {
			t.Fatalf("unexpected body: %+v", req)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := &HelixClient{BaseURL: srv.URL, ClientID: "cid", AccessToken: "tok"}
	if err := c.BanUser(context.Background(), "b1", "m1", "u1", "spam"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTimeoutUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/moderation/bans" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var req banUserRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if req.Data.UserID != "u1" || req.Data.Duration != 60 || req.Data.Reason != "caps" {
			t.Fatalf("unexpected body: %+v", req)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := &HelixClient{BaseURL: srv.URL, ClientID: "cid", AccessToken: "tok"}
	if err := c.TimeoutUser(context.Background(), "b1", "m1", "u1", 60, "caps"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTimeoutUserRejectsOutOfRange(t *testing.T) {
	c := &HelixClient{ClientID: "cid", AccessToken: "tok"}
	if err := c.TimeoutUser(context.Background(), "b1", "m1", "u1", 0, ""); err == nil {
		t.Fatal("expected error")
	}
}

func TestUnbanUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/moderation/bans" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("broadcaster_id") != "b1" || q.Get("moderator_id") != "m1" || q.Get("user_id") != "u1" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := &HelixClient{BaseURL: srv.URL, ClientID: "cid", AccessToken: "tok"}
	if err := c.UnbanUser(context.Background(), "b1", "m1", "u1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDeleteChatMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/moderation/chat" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("broadcaster_id") != "b1" || q.Get("moderator_id") != "m1" || q.Get("message_id") != "msg1" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := &HelixClient{BaseURL: srv.URL, ClientID: "cid", AccessToken: "tok"}
	if err := c.DeleteChatMessage(context.Background(), "b1", "m1", "msg1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestClearChatRequiresIDs(t *testing.T) {
	c := &HelixClient{BaseURL: "http://unused", ClientID: "cid", AccessToken: "tok"}
	if err := c.ClearChat(context.Background(), "b1", ""); err == nil {
		t.Fatal("expected error without a moderator id")
	}
	if err := c.ClearChat(context.Background(), "", "m1"); err == nil {
		t.Fatal("expected error without a broadcaster id")
	}
}

func TestSendChatMessageReply(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[{"message_id":"abc","is_sent":true}]}`))
	}))
	defer srv.Close()

	c := &HelixClient{BaseURL: srv.URL, ClientID: "cid", AccessToken: "tok"}
	if _, err := c.SendChatMessage(context.Background(), "b1", "u1", "hello", "parent-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if body["reply_parent_message_id"] != "parent-1" {
		t.Fatalf("reply_parent_message_id not sent: %+v", body)
	}
}
