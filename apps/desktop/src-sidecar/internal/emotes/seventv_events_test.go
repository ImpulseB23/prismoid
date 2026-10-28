package emotes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
)

// Frames captured from wss://events.7tv.io/v3, with avatar urls and some
// connection fields trimmed.
const (
	stvHello = `{"d":{"heartbeat_interval":46219,"session_id":"01M60F0YSC9A5MYDE42DT02D19","subscription_limit":500,"instance":{"name":"event-api-7","population":66812}},"op":1,"t":1793164606252,"s":0}`

	stvRadialPaint = `{"type":"cosmetic.create","body":{"id":"01HEBYHWN0000EV2G1SJ85XJQR","kind":10,"object":{"id":"01HEBYHWN0000EV2G1SJ85XJQR","kind":"PAINT","data":{"id":"01HEBYHWN0000EV2G1SJ85XJQR","name":"Firebrand","color":null,"gradients":[],"shadows":[{"x_offset":0.0,"y_offset":0.0,"radius":4.0,"color":-535887617}],"text":null,"function":"RADIAL_GRADIENT","repeat":false,"angle":0,"shape":"circle","image_url":"","stops":[{"at":0.15,"color":-589569},{"at":0.3,"color":-7012097},{"at":1.0,"color":-618852353}]}}}}`

	stvURLPaint = `{"type":"cosmetic.create","body":{"id":"01HBXZS5680009NC1Q0NCNE82C","kind":10,"object":{"id":"01HBXZS5680009NC1Q0NCNE82C","kind":"PAINT","data":{"id":"01HBXZS5680009NC1Q0NCNE82C","name":"TwitchCon 2023 Las Vegas","color":null,"gradients":[],"shadows":[{"x_offset":0.0,"y_offset":0.0,"radius":0.1,"color":-1589200129},{"x_offset":1.0,"y_offset":1.0,"radius":0.1,"color":-1660874497}],"text":null,"function":"URL","repeat":false,"angle":0,"shape":"circle","image_url":"https://cdn.7tv.app/paint/01HBXZS5680009NC1Q0NCNE82C/layer/01JAMR2BPQYF8Y2KQZF5Q6BDXR/1x.webp","stops":[]}}}}`

	stvBadge = `{"type":"cosmetic.create","body":{"id":"01JFQTXCRE600BMC0214W6KHMF","kind":10,"object":{"id":"01JFQTXCRE600BMC0214W6KHMF","kind":"BADGE","data":{"id":"01JFQTXCRE600BMC0214W6KHMF","name":"Enchanted Glint","tag":"","tooltip":"Christmas Gifting 2024 (10 Gifter)","host":{"url":"//cdn.7tv.app/badge/01JFQTXCRE600BMC0214W6KHMF","files":[{"name":"1x.webp","static_name":"1x_static.webp","width":18,"height":18,"frame_count":100,"size":33750,"format":"WEBP"}]}}}}}`

	stvPaintEntitlement = `{"type":"entitlement.create","body":{"id":"00000000000000000000000000","kind":10,"object":{"id":"00000000000000000000000000","kind":"PAINT","ref_id":"01HEBYHWN0000EV2G1SJ85XJQR","user":{"id":"01HD25TP0G000506K0FGX9BTDP","username":"kaesoni","display_name":"kaesoni","style":{"color":-5635841,"paint_id":"01HEBYHWN0000EV2G1SJ85XJQR","badge_id":"01GXP5DNHR000CV9HPMT8GM9JZ"},"role_ids":["01G68MMQFR0007J6GNM9E2M0TM","01F37R3RFR0000K96678WEQT01"],"connections":[{"id":"472256554","platform":"TWITCH","username":"kaesoni","display_name":"kaesoni","linked_at":1697659050681,"emote_capacity":1000,"emote_set_id":"01HD27G300000C97R3BFM16S2B"}]}}}}`

	stvBadgeEntitlement = `{"type":"entitlement.create","body":{"id":"00000000000000000000000000","kind":10,"object":{"id":"00000000000000000000000000","kind":"BADGE","ref_id":"01JFQTXCRE600BMC0214W6KHMF","user":{"id":"01F92F09HR0009Z5XHWYC5XWJR","username":"pojoga3","connections":[{"id":"106210643","platform":"TWITCH","username":"pojoga3"},{"id":"2893283","platform":"KICK","username":"pojoga3"}]}}}}`
)

type notified struct {
	typ     string
	payload any
}

func collect() (func(string, any), func() []notified) {
	var mu sync.Mutex
	var got []notified
	return func(typ string, payload any) {
			mu.Lock()
			got = append(got, notified{typ, payload})
			mu.Unlock()
		}, func() []notified {
			mu.Lock()
			defer mu.Unlock()
			return append([]notified(nil), got...)
		}
}

func dispatch(t *testing.T, raw string) []notified {
	t.Helper()
	notify, got := collect()
	handleSevenTVDispatch(json.RawMessage(raw), notify, zerolog.Nop())
	return got()
}

func TestSevenTVColor(t *testing.T) {
	for in, want := range map[int64]string{
		-1:          "#ffffffff",
		-1857617921: "#9146ffff",
		-589569:     "#fff700ff",
		102:         "#00000066",
	} {
		if got := sevenTVColor(in); got != want {
			t.Errorf("sevenTVColor(%d) = %s, want %s", in, got, want)
		}
	}
}

func TestDispatch_RadialPaint(t *testing.T) {
	got := dispatch(t, stvRadialPaint)
	want := []notified{{"seventv_paint", Paint{
		ID:       "01HEBYHWN0000EV2G1SJ85XJQR",
		Name:     "Firebrand",
		Function: "RADIAL_GRADIENT",
		Shape:    "circle",
		Stops: []PaintStop{
			{At: 0.15, Color: "#fff700ff"},
			{At: 0.3, Color: "#ff9500ff"},
			{At: 1, Color: "#db1d0fff"},
		},
		Shadows: []PaintShadow{{Radius: 4, Color: "#e00f00ff"}},
	}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestDispatch_URLPaint(t *testing.T) {
	got := dispatch(t, stvURLPaint)
	if len(got) != 1 {
		t.Fatalf("expected one paint, got %+v", got)
	}
	p := got[0].payload.(Paint)
	if p.Function != "URL" || p.ImageURL != "https://cdn.7tv.app/paint/01HBXZS5680009NC1Q0NCNE82C/layer/01JAMR2BPQYF8Y2KQZF5Q6BDXR/1x.webp" {
		t.Fatalf("unexpected url paint %+v", p)
	}
	if len(p.Stops) != 0 || len(p.Shadows) != 2 || p.Shadows[1].X != 1 || p.Shadows[1].Y != 1 {
		t.Fatalf("unexpected stops or shadows %+v", p)
	}
}

func TestDispatch_PaintColor(t *testing.T) {
	raw := strings.Replace(stvRadialPaint, `"color":null`, `"color":-1857617921`, 1)
	if p := dispatch(t, raw)[0].payload.(Paint); p.Color != "#9146ffff" {
		t.Fatalf("expected paint color, got %q", p.Color)
	}
	raw = strings.Replace(stvRadialPaint, `"color":null`, `"color":0`, 1)
	if p := dispatch(t, raw)[0].payload.(Paint); p.Color != "" {
		t.Fatalf("zero color should inherit, got %q", p.Color)
	}
}

func TestDispatch_SkipsUnusablePaints(t *testing.T) {
	for _, raw := range []string{
		stvBadge,
		stvBadgeEntitlement,
		strings.Replace(stvRadialPaint, "RADIAL_GRADIENT", "SPIRAL", 1),
		strings.Replace(stvRadialPaint, `"stops":[{"at":0.15,"color":-589569},{"at":0.3,"color":-7012097},{"at":1.0,"color":-618852353}]`, `"stops":[]`, 1),
		strings.Replace(stvURLPaint, `"image_url":"https://cdn.7tv.app/paint/01HBXZS5680009NC1Q0NCNE82C/layer/01JAMR2BPQYF8Y2KQZF5Q6BDXR/1x.webp"`, `"image_url":""`, 1),
		strings.Replace(stvRadialPaint, `"data":{`, `"data":{"angle":"x",`, 1),
		`{"type":"emote_set.update","body":{"id":"x"}}`,
		`{"type":"entitlement.reset","body":{}}`,
		`[]`,
	} {
		if got := dispatch(t, raw); len(got) != 0 {
			t.Errorf("expected nothing for %.80s, got %+v", raw, got)
		}
	}
}

func TestDispatch_Entitlements(t *testing.T) {
	want := []notified{{"seventv_entitlement", PaintEntitlement{
		Action:    "create",
		UserID:    "472256554",
		SevenTVID: "01HD25TP0G000506K0FGX9BTDP",
		PaintID:   "01HEBYHWN0000EV2G1SJ85XJQR",
	}}}
	if got := dispatch(t, stvPaintEntitlement); !reflect.DeepEqual(got, want) {
		t.Fatalf("create: got %+v", got)
	}

	deleted := strings.Replace(stvPaintEntitlement, "entitlement.create", "entitlement.delete", 1)
	want[0].payload = PaintEntitlement{
		Action:    "delete",
		UserID:    "472256554",
		SevenTVID: "01HD25TP0G000506K0FGX9BTDP",
		PaintID:   "01HEBYHWN0000EV2G1SJ85XJQR",
	}
	if got := dispatch(t, deleted); !reflect.DeepEqual(got, want) {
		t.Fatalf("delete: got %+v", got)
	}

	reset := `{"type":"entitlement.reset","body":{"id":"01HD25TP0G000506K0FGX9BTDP"}}`
	want[0].payload = PaintEntitlement{Action: "reset", SevenTVID: "01HD25TP0G000506K0FGX9BTDP"}
	if got := dispatch(t, reset); !reflect.DeepEqual(got, want) {
		t.Fatalf("reset: got %+v", got)
	}
}

type stvFrame struct {
	Op int `json:"op"`
	D  struct {
		Type      string            `json:"type"`
		Condition map[string]string `json:"condition"`
	} `json:"d"`
}

// stvServer runs handle for every EventAPI connection and returns its url.
func stvServer(t *testing.T, handle func(ctx context.Context, conn *websocket.Conn, n int)) string {
	t.Helper()
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		handle(r.Context(), conn, int(n.Add(1)))
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func readFrame(ctx context.Context, t *testing.T, conn *websocket.Conn) (stvFrame, bool) {
	var f stvFrame
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, data, err := conn.Read(readCtx)
	if err != nil {
		return f, false
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Errorf("bad frame %s", data)
	}
	return f, true
}

func write(ctx context.Context, conn *websocket.Conn, s string) {
	_ = conn.Write(ctx, websocket.MessageText, []byte(s))
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func newTestEvents(t *testing.T, wsURL, apiURL string, notify func(string, any)) *SevenTVEvents {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	e := NewSevenTVEvents(ctx, notify, zerolog.Nop())
	e.URL = wsURL
	e.API.BaseURL = apiURL
	e.SetEnabled(true)
	return e
}

func TestSevenTVEvents_SwitchOpensAndClosesSocket(t *testing.T) {
	var dials atomic.Int32
	subs := make(chan int, 8)
	url := stvServer(t, func(ctx context.Context, conn *websocket.Conn, n int) {
		dials.Add(1)
		write(ctx, conn, stvHello)
		for {
			f, ok := readFrame(ctx, t, conn)
			if !ok {
				return
			}
			if f.Op == opSubscribe {
				subs <- n
			}
		}
	})
	var apiCalls atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiCalls.Add(1)
		http.NotFound(w, r)
	}))
	t.Cleanup(api.Close)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	e := NewSevenTVEvents(ctx, func(string, any) {}, zerolog.Nop())
	e.URL = url
	e.API.BaseURL = api.URL
	e.SetUser("me")
	e.Join("42")
	e.SetEnabled(false)
	time.Sleep(50 * time.Millisecond)
	if dials.Load() != 0 || apiCalls.Load() != 0 {
		t.Fatalf("talked to 7tv while off: dials %d api %d", dials.Load(), apiCalls.Load())
	}

	e.SetEnabled(true)
	e.SetEnabled(true)
	for range 2 {
		if n := <-subs; n != 1 {
			t.Fatalf("subscribed on connection %d", n)
		}
	}
	waitFor(t, func() bool { return apiCalls.Load() == 1 })

	e.SetEnabled(false)
	waitFor(t, func() bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return !e.running
	})
	e.Join("43")
	time.Sleep(50 * time.Millisecond)
	if dials.Load() != 1 {
		t.Fatalf("joined while off reconnected: dials %d", dials.Load())
	}

	e.SetEnabled(true)
	got := map[int]int{}
	for range 4 {
		got[<-subs]++
	}
	if got[2] != 4 {
		t.Fatalf("expected both channels resubscribed on a new socket, got %v", got)
	}
	if len(e.Joined()) != 2 {
		t.Fatalf("joined %v", e.Joined())
	}
}

func TestSevenTVEvents_SubscribesForwardsAndSendsPresence(t *testing.T) {
	frames := make(chan stvFrame, 8)
	url := stvServer(t, func(ctx context.Context, conn *websocket.Conn, _ int) {
		write(ctx, conn, stvHello)
		for range 2 {
			f, ok := readFrame(ctx, t, conn)
			if !ok {
				return
			}
			frames <- f
		}
		write(ctx, conn, `{"op":2,"d":{"count":0}}`)
		write(ctx, conn, `{"op":6,"d":{"message":"nope"}}`)
		write(ctx, conn, `{"op":0,"d":`+stvRadialPaint+`}`)
		write(ctx, conn, `{"op":0,"d":`+stvPaintEntitlement+`}`)
		_, _, _ = conn.Read(ctx)
	})

	var presence atomic.Value
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/users/twitch/me":
			_, _ = w.Write([]byte(`{"id":"me","platform":"TWITCH","user":{"id":"stv-me"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/users/stv-me/presences":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			presence.Store(body)
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(api.Close)

	notify, got := collect()
	e := newTestEvents(t, url, api.URL, notify)
	e.SetUser("me")
	e.Join("42")
	e.Join("42")

	for _, topic := range []string{"cosmetic.*", "entitlement.*"} {
		select {
		case f := <-frames:
			if f.Op != opSubscribe || f.D.Type != topic || !reflect.DeepEqual(f.D.Condition, map[string]string{"ctx": "channel", "platform": "TWITCH", "id": "42"}) {
				t.Fatalf("unexpected subscribe %+v", f)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("no subscribe")
		}
	}
	waitFor(t, func() bool { return len(got()) == 2 })
	if got()[0].typ != "seventv_paint" || got()[1].typ != "seventv_entitlement" {
		t.Fatalf("unexpected notifications %+v", got())
	}
	waitFor(t, func() bool { return presence.Load() != nil })
	want := map[string]any{
		"kind":       float64(1),
		"passive":    true,
		"session_id": "01M60F0YSC9A5MYDE42DT02D19",
		"data":       map[string]any{"platform": "TWITCH", "id": "42"},
	}
	if body := presence.Load(); !reflect.DeepEqual(body, want) {
		t.Fatalf("presence body %+v", body)
	}
}

func TestSevenTVEvents_NoPresenceWithoutAccount(t *testing.T) {
	var lookups, posts atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
		} else {
			lookups.Add(1)
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(api.Close)

	subscribed := make(chan struct{}, 4)
	url := stvServer(t, func(ctx context.Context, conn *websocket.Conn, _ int) {
		write(ctx, conn, stvHello)
		for {
			if _, ok := readFrame(ctx, t, conn); !ok {
				return
			}
			subscribed <- struct{}{}
		}
	})

	e := newTestEvents(t, url, api.URL, func(string, any) {})
	e.SetUser("nobody")
	e.Join("1")
	e.Join("2")
	for range 4 {
		<-subscribed
	}
	waitFor(t, func() bool { return lookups.Load() >= 1 })
	time.Sleep(50 * time.Millisecond)
	if lookups.Load() != 1 || posts.Load() != 0 {
		t.Fatalf("lookups %d posts %d", lookups.Load(), posts.Load())
	}
}

func TestSevenTVEvents_ReconnectResubscribes(t *testing.T) {
	subs := make(chan int, 8)
	url := stvServer(t, func(ctx context.Context, conn *websocket.Conn, n int) {
		write(ctx, conn, stvHello)
		for range 2 {
			if f, ok := readFrame(ctx, t, conn); ok && f.Op == opSubscribe {
				subs <- n
			}
		}
		if n == 1 {
			write(ctx, conn, `{"op":4,"d":{"reason":"restart"}}`)
		}
		_, _, _ = conn.Read(ctx)
	})

	e := newTestEvents(t, url, "http://127.0.0.1:1", func(string, any) {})
	e.Join("42")
	var seen []int
	for len(seen) < 4 {
		select {
		case n := <-subs:
			seen = append(seen, n)
		case <-time.After(3 * time.Second):
			t.Fatalf("subscriptions so far %v", seen)
		}
	}
	if !reflect.DeepEqual(seen, []int{1, 1, 2, 2}) {
		t.Fatalf("unexpected subscribe order %v", seen)
	}
}

func TestSevenTVEvents_LeaveUnsubscribesThenCloses(t *testing.T) {
	frames := make(chan stvFrame, 16)
	closed := make(chan struct{})
	url := stvServer(t, func(ctx context.Context, conn *websocket.Conn, _ int) {
		write(ctx, conn, stvHello)
		for {
			f, ok := readFrame(ctx, t, conn)
			if !ok {
				close(closed)
				return
			}
			frames <- f
		}
	})

	e := newTestEvents(t, url, "http://127.0.0.1:1", func(string, any) {})
	e.Join("1")
	e.Join("2")
	for range 4 {
		<-frames
	}
	e.Leave("1")
	e.Leave("1")
	for _, topic := range []string{"cosmetic.*", "entitlement.*"} {
		f := <-frames
		if f.Op != opUnsubscribe || f.D.Type != topic || f.D.Condition["id"] != "1" {
			t.Fatalf("unexpected unsubscribe %+v", f)
		}
	}
	e.Leave("2")
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("socket stayed open with no channels")
	}
	waitFor(t, func() bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return !e.running
	})
}

func TestSevenTVEvents_ConnectErrors(t *testing.T) {
	for name, first := range map[string]string{
		"not hello":     `{"op":0,"d":{}}`,
		"bad hello":     `{"op":1,"d":{"session_id":"s"}}`,
		"end of stream": stvHello,
	} {
		t.Run(name, func(t *testing.T) {
			url := stvServer(t, func(ctx context.Context, conn *websocket.Conn, _ int) {
				write(ctx, conn, first)
				write(ctx, conn, `{"op":7,"d":{"code":4000,"message":"bye"}}`)
				_, _, _ = conn.Read(ctx)
			})
			e := newTestEvents(t, url, "http://127.0.0.1:1", func(string, any) {})
			e.channels["1"] = struct{}{}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			greeted, err := e.connectAndListen(ctx)
			if err == nil || greeted != (name == "end of stream") {
				t.Fatalf("greeted %v err %v", greeted, err)
			}
		})
	}
}

func TestSevenTVEvents_DialFailureRetries(t *testing.T) {
	e := newTestEvents(t, "ws://127.0.0.1:1/", "http://127.0.0.1:1", func(string, any) {})
	e.Join("1")
	e.Leave("1")
	waitFor(t, func() bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return !e.running
	})
}
