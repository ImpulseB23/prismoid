package twitch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
)

func welcomeMsg(sessionID string, keepaliveSec int) []byte {
	msg := fmt.Sprintf(`{
		"metadata":{"message_id":"1","message_type":"session_welcome","message_timestamp":"2025-01-01T00:00:00Z"},
		"payload":{"session":{"id":"%s","keepalive_timeout_seconds":%d}}
	}`, sessionID, keepaliveSec)
	return []byte(msg)
}

func notificationMsg(id, text string) []byte {
	msg := fmt.Sprintf(`{
		"metadata":{"message_id":"%s","message_type":"notification","message_timestamp":"2025-01-01T00:00:01Z"},
		"payload":{"subscription":{"type":"channel.chat.message"},"event":{"message":{"text":"%s"}}}
	}`, id, text)
	return []byte(msg)
}

func keepaliveMsg() []byte {
	return []byte(`{"metadata":{"message_id":"ka-1","message_type":"session_keepalive","message_timestamp":"2025-01-01T00:00:02Z"},"payload":{}}`)
}

func revocationMsg(status, broadcaster string) []byte {
	return []byte(fmt.Sprintf(`{
		"metadata":{"message_id":"rev-1","message_type":"revocation","message_timestamp":"2025-01-01T00:00:04Z"},
		"payload":{"subscription":{"type":"channel.chat.message","status":"%s","condition":{"broadcaster_user_id":"%s","user_id":"user-1"}}}
	}`, status, broadcaster))
}

// helixRecorder is a Helix stub that accepts every subscription with a
// fresh id and remembers each request.
type helixRecorder struct {
	mu      sync.Mutex
	posts   []SubscriptionRequest
	deletes []string
	next    int
}

func (h *helixRecorder) handler(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch r.Method {
	case http.MethodPost:
		var req SubscriptionRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		h.posts = append(h.posts, req)
		h.next++
		w.WriteHeader(http.StatusAccepted)
		_, _ = fmt.Fprintf(w, `{"data":[{"id":"sub-%d","status":"enabled"}]}`, h.next)
	case http.MethodDelete:
		h.deletes = append(h.deletes, r.URL.Query().Get("id"))
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *helixRecorder) postCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.posts)
}

func (h *helixRecorder) deleted() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.deletes...)
}

func acceptingHelix(t *testing.T) (*httptest.Server, *helixRecorder) {
	t.Helper()
	rec := &helixRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(rec.handler))
	t.Cleanup(srv.Close)
	return srv, rec
}

// wsServer runs handle for every WebSocket connection and returns the ws URL.
func wsServer(t *testing.T, handle func(conn *websocket.Conn, n int)) string {
	t.Helper()
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		handle(conn, int(n.Add(1)))
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func newTestSession(ctx context.Context, wsURL, helixURL string, out chan<- []byte, notify Notify) *Session {
	s := NewSession(ctx, out, zerolog.Nop(), notify)
	s.HelixBase = helixURL
	s.WSURL = wsURL
	s.Configure("user-1", "test-token", "test-client")
	return s
}

// drainChan reads everything currently in ch (non-blocking after a brief
// settle) so tests can assert on the bytes the session sent.
func drainChan(ch <-chan []byte) [][]byte {
	var msgs [][]byte
	deadline := time.After(50 * time.Millisecond)
	for {
		select {
		case msg := <-ch:
			msgs = append(msgs, msg)
		case <-deadline:
			return msgs
		}
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestSessionReceivesNotifications(t *testing.T) {
	helix, _ := acceptingHelix(t)
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		ctx := context.Background()
		_ = conn.Write(ctx, websocket.MessageText, welcomeMsg("sess-1", 30))
		_ = conn.Write(ctx, websocket.MessageText, notificationMsg("n-1", "hello chat"))
		_ = conn.Write(ctx, websocket.MessageText, notificationMsg("n-2", "second msg"))
		time.Sleep(100 * time.Millisecond)
		_ = conn.Close(websocket.StatusNormalClosure, "done")
	})

	out := make(chan []byte, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, ws, helix.URL, out, nil)
	s.Join("broadcaster-1", nil)

	waitFor(t, "two notifications", func() bool { return len(out) >= 2 })
	msgs := drainChan(out)
	if msgs[0][0] != 0x01 {
		t.Fatalf("expected tag 0x01, got %x", msgs[0][0])
	}
	var env Envelope
	if err := json.Unmarshal(msgs[0][1:], &env); err != nil {
		t.Fatalf("unmarshal first message: %v", err)
	}
	if env.Metadata.MessageType != "notification" {
		t.Fatalf("expected notification, got %s", env.Metadata.MessageType)
	}
}

func TestSessionHandlesKeepalive(t *testing.T) {
	helix, _ := acceptingHelix(t)
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		ctx := context.Background()
		_ = conn.Write(ctx, websocket.MessageText, welcomeMsg("sess-2", 30))
		_ = conn.Write(ctx, websocket.MessageText, keepaliveMsg())
		_ = conn.Write(ctx, websocket.MessageText, notificationMsg("n-1", "after keepalive"))
		time.Sleep(100 * time.Millisecond)
		_ = conn.Close(websocket.StatusNormalClosure, "done")
	})

	out := make(chan []byte, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	newTestSession(ctx, ws, helix.URL, out, nil).Join("broadcaster-1", nil)
	waitFor(t, "notification after keepalive", func() bool { return len(out) >= 1 })
}

func TestSessionSubscribesEveryJoinedChannelAndImmediatelyWhenConnected(t *testing.T) {
	helix, rec := acceptingHelix(t)
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		_ = conn.Write(context.Background(), websocket.MessageText, welcomeMsg("sess-3", 30))
		time.Sleep(3 * time.Second)
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), nil)
	s.Join("a", nil)
	s.Join("b", nil)
	// five chat subscriptions, channel.moderate and the two automod ones, per channel
	waitFor(t, "both channels subscribed", func() bool { return rec.postCount() == 16 })

	s.Join("c", nil)
	waitFor(t, "late join subscribed on the live socket", func() bool { return rec.postCount() == 24 })

	rec.mu.Lock()
	defer rec.mu.Unlock()
	seen := map[string]int{}
	for _, p := range rec.posts {
		if p.Transport.SessionID != "sess-3" {
			t.Fatalf("subscription made on wrong session: %+v", p)
		}
		seen[p.Condition["broadcaster_user_id"]]++
	}
	if seen["a"] != 8 || seen["b"] != 8 || seen["c"] != 8 {
		t.Fatalf("unexpected per-channel subscriptions: %v", seen)
	}
}

func TestSessionLeaveDeletesOnlyThatChannel(t *testing.T) {
	helix, rec := acceptingHelix(t)
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		_ = conn.Write(context.Background(), websocket.MessageText, welcomeMsg("sess-4", 30))
		time.Sleep(3 * time.Second)
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), nil)
	s.Join("a", nil)
	waitFor(t, "a subscribed", func() bool { return rec.postCount() == 8 })
	s.Join("b", nil)
	waitFor(t, "b subscribed", func() bool { return rec.postCount() == 16 })

	s.Leave("a")
	waitFor(t, "a's subscriptions deleted", func() bool { return len(rec.deleted()) == 8 })
	for _, id := range rec.deleted() {
		n := 0
		_, _ = fmt.Sscanf(id, "sub-%d", &n)
		if n < 1 || n > 8 {
			t.Fatalf("deleted a subscription that was not a's: %s", id)
		}
	}
	if joined := s.Joined(); len(joined) != 1 || joined[0] != "b" {
		t.Fatalf("expected only b to remain, got %v", joined)
	}
}

func TestSessionAuthErrorIsReported(t *testing.T) {
	helix := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Unauthorized"}`))
	}))
	defer helix.Close()
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		_ = conn.Write(context.Background(), websocket.MessageText, welcomeMsg("sess-5", 30))
		time.Sleep(2 * time.Second)
	})

	var notified atomic.Bool
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), func(msgType string, _ any) {
		if msgType == "auth_error" {
			notified.Store(true)
		}
	}).Join("broadcaster-1", nil)
	waitFor(t, "auth_error notification", notified.Load)
}

func TestSessionReconnectCarriesSubscriptionsOver(t *testing.T) {
	helix, rec := acceptingHelix(t)
	var secondConnected atomic.Bool
	second := wsServer(t, func(conn *websocket.Conn, _ int) {
		secondConnected.Store(true)
		ctx := context.Background()
		_ = conn.Write(ctx, websocket.MessageText, welcomeMsg("sess-new", 30))
		_ = conn.Write(ctx, websocket.MessageText, notificationMsg("n-after-reconnect", "reconnected"))
		time.Sleep(2 * time.Second)
	})
	first := wsServer(t, func(conn *websocket.Conn, _ int) {
		ctx := context.Background()
		_ = conn.Write(ctx, websocket.MessageText, welcomeMsg("sess-old", 30))
		reconnect := fmt.Sprintf(`{
			"metadata":{"message_id":"r-1","message_type":"session_reconnect","message_timestamp":"2025-01-01T00:00:03Z"},
			"payload":{"session":{"id":"sess-old","reconnect_url":"%s"}}
		}`, second)
		_ = conn.Write(ctx, websocket.MessageText, []byte(reconnect))
		time.Sleep(2 * time.Second)
	})

	out := make(chan []byte, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	newTestSession(ctx, first, helix.URL, out, nil).Join("broadcaster-1", nil)

	waitFor(t, "connection to the reconnect url", secondConnected.Load)
	waitFor(t, "message after reconnect", func() bool { return len(out) >= 1 })
	// The reconnect url carries the old subscriptions, so nothing is
	// subscribed twice.
	time.Sleep(100 * time.Millisecond)
	if n := rec.postCount(); n != 8 {
		t.Fatalf("expected 8 subscriptions in total, got %d", n)
	}
}

func TestSessionResubscribesAfterADrop(t *testing.T) {
	helix, rec := acceptingHelix(t)
	ws := wsServer(t, func(conn *websocket.Conn, n int) {
		_ = conn.Write(context.Background(), websocket.MessageText, welcomeMsg(fmt.Sprintf("sess-%d", n), 30))
		if n == 1 {
			_ = conn.Close(websocket.StatusNormalClosure, "bye")
			return
		}
		time.Sleep(3 * time.Second)
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), nil).Join("broadcaster-1", nil)
	waitFor(t, "subscriptions on both sockets", func() bool { return rec.postCount() == 16 })
}

func TestSessionRevocationIsReportedAndKeepsTheSocket(t *testing.T) {
	helix, _ := acceptingHelix(t)
	var dials atomic.Int32
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		dials.Add(1)
		ctx := context.Background()
		_ = conn.Write(ctx, websocket.MessageText, welcomeMsg("sess-rev", 30))
		_ = conn.Write(ctx, websocket.MessageText, revocationMsg("user_removed", "broadcaster-1"))
		time.Sleep(2 * time.Second)
	})

	var notifyType atomic.Value
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), func(msgType string, _ any) {
		if msgType == "revocation" {
			notifyType.Store(msgType)
		}
	}).Join("broadcaster-1", nil)

	waitFor(t, "revocation notification", func() bool { return notifyType.Load() != nil })
	time.Sleep(300 * time.Millisecond)
	if dials.Load() != 1 {
		t.Fatalf("a revocation must not drop the socket, got %d connections", dials.Load())
	}
}

func TestSessionDropsAChannelWhenSubscribeIsForbidden(t *testing.T) {
	helix := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Forbidden","status":403,"message":"subscription missing proper authorization"}`))
	}))
	defer helix.Close()
	var dials atomic.Int32
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		dials.Add(1)
		_ = conn.Write(context.Background(), websocket.MessageText, welcomeMsg("sess-ban", 30))
		time.Sleep(2 * time.Second)
	})

	var got atomic.Value
	var detail atomic.Value
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), func(msgType string, payload any) {
		if msgType == "chat_banned" {
			got.Store(payload)
		}
	})
	s.Join("broadcaster-1", func(d string) { detail.Store(d) })

	waitFor(t, "ban callback", func() bool { return detail.Load() != nil })
	if !strings.Contains(detail.Load().(string), "missing proper authorization") {
		t.Fatalf("unexpected detail %q", detail.Load())
	}
	p, ok := got.Load().(ChatBannedPayload)
	if !ok || p.BroadcasterID != "broadcaster-1" {
		t.Fatalf("unexpected chat_banned payload: %#v", got.Load())
	}
	if len(s.Joined()) != 0 {
		t.Fatalf("banned channel should be dropped, still joined: %v", s.Joined())
	}
	if dials.Load() != 1 {
		t.Fatalf("expected a single connection, got %d", dials.Load())
	}
}

func TestSessionDropsOnlyTheBannedChannelOnRevocation(t *testing.T) {
	helix, _ := acceptingHelix(t)
	var dials atomic.Int32
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		dials.Add(1)
		ctx := context.Background()
		_ = conn.Write(ctx, websocket.MessageText, welcomeMsg("sess-rev-ban", 30))
		time.Sleep(200 * time.Millisecond)
		_ = conn.Write(ctx, websocket.MessageText, revocationMsg("chat_user_banned", "a"))
		time.Sleep(2 * time.Second)
	})

	var detail atomic.Value
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), nil)
	s.Join("a", func(d string) { detail.Store(d) })
	s.Join("b", nil)

	waitFor(t, "ban callback", func() bool { return detail.Load() != nil })
	if detail.Load().(string) != "chat_user_banned" {
		t.Fatalf("unexpected detail %q", detail.Load())
	}
	if joined := s.Joined(); len(joined) != 1 || joined[0] != "b" {
		t.Fatalf("expected b to stay joined, got %v", joined)
	}
	if dials.Load() != 1 {
		t.Fatalf("expected no reconnect after a ban, got %d connections", dials.Load())
	}
}

func TestSessionChannelFull(t *testing.T) {
	helix, _ := acceptingHelix(t)
	done := make(chan struct{})
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		ctx := context.Background()
		_ = conn.Write(ctx, websocket.MessageText, welcomeMsg("sess-full", 30))
		for i := range 20 {
			_ = conn.Write(ctx, websocket.MessageText, notificationMsg(
				fmt.Sprintf("n-%d", i),
				"will eventually overflow the tiny channel",
			))
		}
		time.Sleep(100 * time.Millisecond)
		_ = conn.Close(websocket.StatusNormalClosure, "done")
		close(done)
	})

	// tiny channel that fills almost immediately; the session must drop
	// without blocking the websocket reader.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	newTestSession(ctx, ws, helix.URL, make(chan []byte, 1), nil).Join("broadcaster-1", nil)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("server never finished writing; reader stalled")
	}
}

// refusingHelix accepts every subscription except the listed types, which
// get the 403 Twitch sends for a missing role or scope.
func refusingHelix(t *testing.T, refused ...string) (*httptest.Server, *helixRecorder) {
	t.Helper()
	rec := &helixRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var req SubscriptionRequest
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &req)
			if slices.Contains(refused, req.Type) {
				rec.mu.Lock()
				rec.posts = append(rec.posts, req)
				rec.mu.Unlock()
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":"Forbidden","status":403,"message":"subscription missing proper authorization"}`))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		rec.handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

func (h *helixRecorder) types() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.posts))
	for _, p := range h.posts {
		out = append(out, p.Type)
	}
	return out
}

func TestSessionSkipsAutoModWhereNotAModerator(t *testing.T) {
	helix, rec := refusingHelix(t, "channel.moderate")
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		_ = conn.Write(context.Background(), websocket.MessageText, welcomeMsg("sess-viewer", 30))
		time.Sleep(2 * time.Second)
	})

	var notified atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), func(string, any) { notified.Add(1) })
	s.Join("a", nil)
	waitFor(t, "chat and moderation attempts", func() bool { return rec.postCount() == 6 })
	time.Sleep(100 * time.Millisecond)

	if slices.Contains(rec.types(), "automod.message.hold") {
		t.Fatalf("automod subscribed in a channel the user does not moderate: %v", rec.types())
	}
	if notified.Load() != 0 || len(s.Joined()) != 1 {
		t.Fatalf("a viewer channel must stay joined without notifications, got %d notifications", notified.Load())
	}
}

func TestSessionKeepsModerationWhenAutoModScopeIsMissing(t *testing.T) {
	helix, rec := refusingHelix(t, "automod.message.hold")
	ws := wsServer(t, func(conn *websocket.Conn, _ int) {
		_ = conn.Write(context.Background(), websocket.MessageText, welcomeMsg("sess-old-grant", 30))
		time.Sleep(2 * time.Second)
	})

	var notified atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, ws, helix.URL, make(chan []byte, 16), func(string, any) { notified.Add(1) })
	s.Join("a", nil)
	waitFor(t, "automod attempt", func() bool { return slices.Contains(rec.types(), "automod.message.hold") })
	time.Sleep(100 * time.Millisecond)

	if slices.Contains(rec.types(), "automod.message.update") {
		t.Fatal("update subscribed after hold was refused")
	}
	if notified.Load() != 0 {
		t.Fatalf("a missing automod scope must stay quiet, got %d notifications", notified.Load())
	}
	s.Leave("a")
	waitFor(t, "chat and moderation subscriptions deleted", func() bool { return len(rec.deleted()) == 6 })
}

func TestReconnectErrorMessage(t *testing.T) {
	e := &reconnectError{url: "wss://example.com/new"}
	if got := e.Error(); got != "reconnect to wss://example.com/new" {
		t.Fatalf("unexpected error message: %s", got)
	}
}

func TestSession_wsURL(t *testing.T) {
	if got := (&Session{}).wsURL(); got != defaultWSURL {
		t.Errorf("expected default %q, got %q", defaultWSURL, got)
	}
	if got := (&Session{WSURL: "wss://override.example/ws"}).wsURL(); got != "wss://override.example/ws" {
		t.Errorf("expected override, got %q", got)
	}
}

// grantHelix accepts chat subscriptions and refuses channel.moderate until
// granted is set, the automod ones until automod is set, the poll ones
// until polls is set and the ad break one until ads is set, the way Twitch
// answers a token missing those scopes. block, when set, holds the first
// channel.moderate request until it is closed.
type grantHelix struct {
	helixRecorder
	granted atomic.Bool
	automod atomic.Bool
	polls   atomic.Bool
	ads     atomic.Bool
	block   chan struct{}
	blocked atomic.Bool
	tries   atomic.Int32
}

func (g *grantHelix) handler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var req SubscriptionRequest
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &req)
		refused := false
		switch {
		case req.Type == "channel.moderate":
			g.tries.Add(1)
			if g.block != nil && g.blocked.CompareAndSwap(false, true) {
				<-g.block
			}
			refused = !g.granted.Load()
		case strings.HasPrefix(req.Type, "automod."):
			refused = !g.automod.Load()
		case strings.HasPrefix(req.Type, "channel.poll."):
			refused = !g.polls.Load()
		case req.Type == "channel.ad_break.begin":
			refused = !g.ads.Load()
		}
		if refused {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"Forbidden","status":403,"message":"subscription missing proper authorization"}`))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	g.helixRecorder.handler(w, r)
}

func (g *grantHelix) typeCount(subType string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, p := range g.posts {
		if p.Type == subType {
			n++
		}
	}
	return n
}

func grantingHelix(t *testing.T, block chan struct{}) (*httptest.Server, *grantHelix) {
	t.Helper()
	g := &grantHelix{block: block}
	srv := httptest.NewServer(http.HandlerFunc(g.handler))
	t.Cleanup(srv.Close)
	return srv, g
}

func idleSocket(t *testing.T, sessionID string) string {
	t.Helper()
	return wsServer(t, func(conn *websocket.Conn, _ int) {
		_ = conn.Write(context.Background(), websocket.MessageText, welcomeMsg(sessionID, 30))
		time.Sleep(3 * time.Second)
	})
}

func TestSessionResubscribeAddsOnlyWhatANewGrantAllows(t *testing.T) {
	helix, g := grantingHelix(t, nil)
	g.automod.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, idleSocket(t, "sess-grant"), helix.URL, make(chan []byte, 16), nil)
	s.Join("a", nil)
	s.Join("b", nil)
	waitFor(t, "chat subscribed, moderation refused", func() bool { return g.postCount() == 10 && g.tries.Load() == 2 })
	if g.typeCount("automod.message.hold") != 0 {
		t.Fatal("automod must wait for channel.moderate")
	}

	g.granted.Store(true)
	s.SetAccessToken("regranted")
	s.Resubscribe()
	waitFor(t, "moderation and automod added to both channels", func() bool {
		return g.typeCount("channel.moderate") == 2 && g.typeCount("automod.message.update") == 2
	})
	time.Sleep(100 * time.Millisecond)
	if g.postCount() != 16 {
		t.Fatalf("chat must not be subscribed twice, got %d subscriptions", g.postCount())
	}
	if len(g.deleted()) != 0 {
		t.Fatalf("nothing should be deleted, got %v", g.deleted())
	}

	s.Leave("a")
	waitFor(t, "a's chat, moderation and automod deleted", func() bool { return len(g.deleted()) == 8 })
}

func TestSessionResubscribeAddsAutoModWhenTheGrantGainsIt(t *testing.T) {
	helix, g := grantingHelix(t, nil)
	g.granted.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, idleSocket(t, "sess-automod"), helix.URL, make(chan []byte, 16), nil)
	s.Join("a", nil)
	waitFor(t, "chat and moderation subscribed, automod refused", func() bool { return g.postCount() == 6 })
	time.Sleep(100 * time.Millisecond)

	g.automod.Store(true)
	s.SetAccessToken("with-automod")
	s.Resubscribe()
	waitFor(t, "automod added", func() bool {
		return g.typeCount("automod.message.hold") == 1 && g.typeCount("automod.message.update") == 1
	})
	time.Sleep(100 * time.Millisecond)
	if g.postCount() != 8 || g.tries.Load() != 1 {
		t.Fatalf("only automod should be new, got %d subscriptions and %d moderation tries", g.postCount(), g.tries.Load())
	}

	s.Leave("a")
	waitFor(t, "every subscription deleted", func() bool { return len(g.deleted()) == 8 })
}

func TestSessionSubscribesBroadcasterFeedsOnlyOnTheOwnChannel(t *testing.T) {
	helix, rec := acceptingHelix(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, idleSocket(t, "sess-own"), helix.URL, make(chan []byte, 16), nil)
	s.Join("a", nil)
	s.Join("user-1", nil)
	// eight per channel, plus three poll, four prediction and one ad break
	// feed at home
	waitFor(t, "both channels subscribed", func() bool { return rec.postCount() == 24 })
	time.Sleep(100 * time.Millisecond)

	rec.mu.Lock()
	feeds := map[string]SubscriptionRequest{}
	for _, p := range rec.posts {
		if strings.HasPrefix(p.Type, "channel.poll.") || strings.HasPrefix(p.Type, "channel.prediction.") || p.Type == "channel.ad_break.begin" {
			feeds[p.Type] = p
		}
	}
	rec.mu.Unlock()
	for _, group := range broadcasterFeeds {
		for _, subType := range group {
			p, ok := feeds[subType]
			if !ok {
				t.Fatalf("%s not subscribed", subType)
			}
			if p.Version != "1" || len(p.Condition) != 1 || p.Condition["broadcaster_user_id"] != "user-1" {
				t.Fatalf("%s subscribed as %+v", subType, p)
			}
		}
	}
	if len(feeds) != 8 {
		t.Fatalf("expected eight broadcaster feeds, got %d", len(feeds))
	}

	s.Leave("user-1")
	waitFor(t, "every feed of the own channel deleted", func() bool { return len(rec.deleted()) == 16 })
}

func TestSessionResubscribeAddsPollsWhenTheGrantGainsThem(t *testing.T) {
	helix, g := grantingHelix(t, nil)
	g.granted.Store(true)
	g.automod.Store(true)
	g.ads.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var notified atomic.Int32
	s := newTestSession(ctx, idleSocket(t, "sess-polls"), helix.URL, make(chan []byte, 16), func(string, any) { notified.Add(1) })
	s.Join("user-1", nil)
	// the refused poll.begin is not recorded, so predictions still land
	waitFor(t, "predictions subscribed, polls refused", func() bool { return g.postCount() == 13 })
	time.Sleep(100 * time.Millisecond)
	if g.typeCount("channel.poll.progress") != 0 || g.typeCount("channel.poll.end") != 0 {
		t.Fatal("the poll group must stop at its first refusal")
	}
	if notified.Load() != 0 || len(s.Joined()) != 1 {
		t.Fatalf("a missing poll scope must stay quiet, got %d notifications", notified.Load())
	}

	g.polls.Store(true)
	s.SetAccessToken("with-polls")
	s.Resubscribe()
	waitFor(t, "polls added", func() bool { return g.typeCount("channel.poll.end") == 1 })
	time.Sleep(100 * time.Millisecond)
	if g.postCount() != 16 || g.typeCount("channel.prediction.begin") != 1 {
		t.Fatalf("only the poll feeds should be new, got %d subscriptions", g.postCount())
	}
}

func TestSessionResubscribeAddsAdBreaksWhenTheGrantGainsThem(t *testing.T) {
	helix, g := grantingHelix(t, nil)
	g.granted.Store(true)
	g.automod.Store(true)
	g.polls.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var notified atomic.Int32
	s := newTestSession(ctx, idleSocket(t, "sess-ads"), helix.URL, make(chan []byte, 16), func(string, any) { notified.Add(1) })
	s.Join("user-1", nil)
	waitFor(t, "polls and predictions subscribed, ad breaks refused", func() bool { return g.postCount() == 15 })
	time.Sleep(100 * time.Millisecond)
	if g.typeCount("channel.ad_break.begin") != 0 {
		t.Fatal("the ad break feed must wait for channel:read:ads")
	}
	if notified.Load() != 0 || len(s.Joined()) != 1 {
		t.Fatalf("a missing ads scope must stay quiet, got %d notifications", notified.Load())
	}

	g.ads.Store(true)
	s.SetAccessToken("with-ads")
	s.Resubscribe()
	waitFor(t, "ad breaks added", func() bool { return g.typeCount("channel.ad_break.begin") == 1 })
	time.Sleep(100 * time.Millisecond)
	if g.postCount() != 16 {
		t.Fatalf("only the ad break feed should be new, got %d subscriptions", g.postCount())
	}

	s.Leave("user-1")
	waitFor(t, "every subscription deleted", func() bool { return len(g.deleted()) == 16 })
}

func TestSessionResubscribeWhileSubscribingRunsAgain(t *testing.T) {
	block := make(chan struct{})
	helix, g := grantingHelix(t, block)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newTestSession(ctx, idleSocket(t, "sess-rerun"), helix.URL, make(chan []byte, 16), nil)
	s.Join("a", nil)
	waitFor(t, "moderation request in flight", g.blocked.Load)

	s.Resubscribe()
	close(block)
	waitFor(t, "moderation tried again on the rerun", func() bool { return g.tries.Load() == 2 })
	time.Sleep(100 * time.Millisecond)
	if g.tries.Load() != 2 || g.postCount() != 5 {
		t.Fatalf("expected one rerun and no duplicate chat, got %d moderation tries, %d subscriptions", g.tries.Load(), g.postCount())
	}
}

func TestSessionResubscribeWithoutSocketIsANoOp(t *testing.T) {
	s := NewSession(context.Background(), nil, zerolog.Nop(), nil)
	s.Resubscribe()
	if len(s.Joined()) != 0 {
		t.Fatalf("unexpected channels %v", s.Joined())
	}
}

func TestSession_AccessTokenConcurrent(t *testing.T) {
	s := NewSession(context.Background(), nil, zerolog.Nop(), nil)
	s.Configure("u", "initial", "cid")

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			s.SetAccessToken("rotated")
		}
		close(done)
	}()
	for i := 0; i < 1000; i++ {
		_ = s.AccessToken()
	}
	<-done

	if got := s.AccessToken(); got != "rotated" {
		t.Errorf("expected rotated, got %q", got)
	}
}
