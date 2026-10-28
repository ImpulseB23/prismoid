package emotes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/backoff"
)

const sevenTVEventsURL = "wss://events.7tv.io/v3"

// EventAPI opcodes, as listed in chatterino7's
// src/providers/seventv/eventapi/Subscription.hpp and the 7TV extension's
// src/worker/index.ts.
const (
	opDispatch    = 0
	opHello       = 1
	opReconnect   = 4
	opError       = 6
	opEndOfStream = 7
	opSubscribe   = 35
	opUnsubscribe = 36
)

// Both official clients subscribe a channel to these two; the channel
// condition delivers the cosmetics and entitlements of whoever announces
// a presence there.
var sevenTVChannelTopics = []string{"cosmetic.*", "entitlement.*"}

// Paint is a 7TV name paint as the host receives it. Colors are CSS
// `#rrggbbaa`; an empty Color means the user's own chat color.
type Paint struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Function string        `json:"function"`
	Color    string        `json:"color,omitempty"`
	Angle    float64       `json:"angle"`
	Shape    string        `json:"shape,omitempty"`
	ImageURL string        `json:"image_url,omitempty"`
	Repeat   bool          `json:"repeat"`
	Stops    []PaintStop   `json:"stops"`
	Shadows  []PaintShadow `json:"shadows"`
}

type PaintStop struct {
	At    float64 `json:"at"`
	Color string  `json:"color"`
}

type PaintShadow struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Radius float64 `json:"radius"`
	Color  string  `json:"color"`
}

// PaintEntitlement tells the host a Twitch user gained ("create") or lost
// ("delete") a paint, or that a 7TV user's cosmetics were all dropped
// ("reset", which carries only SevenTVID).
type PaintEntitlement struct {
	Action    string `json:"action"`
	UserID    string `json:"user_id,omitempty"`
	SevenTVID string `json:"seventv_id"`
	PaintID   string `json:"paint_id,omitempty"`
}

// SevenTVEvents keeps one EventAPI socket for every joined Twitch channel
// and forwards paint cosmetics and entitlements to the host as
// `seventv_paint` and `seventv_entitlement` notifications. Joined channels
// are tracked either way, but nothing reaches 7TV until the host enables
// paints: the socket is up only while enabled with at least one channel.
type SevenTVEvents struct {
	URL    string // override for testing; "" uses default
	API    *SevenTVClient
	Notify func(msgType string, payload any)
	Log    zerolog.Logger

	ctx context.Context

	mu        sync.Mutex
	channels  map[string]struct{}
	enabled   bool
	conn      *websocket.Conn
	connCtx   context.Context
	sessionID string
	stop      context.CancelFunc
	running   bool
	userID    string

	selfMu     sync.Mutex
	selfFor    string
	selfID     string
	selfLooked bool
}

func NewSevenTVEvents(ctx context.Context, notify func(string, any), log zerolog.Logger) *SevenTVEvents {
	return &SevenTVEvents{
		API:      &SevenTVClient{},
		Notify:   notify,
		Log:      log,
		ctx:      ctx,
		channels: make(map[string]struct{}),
	}
}

// SetUser records the signed-in Twitch user. When they have a 7TV account,
// each joined channel gets a passive presence so their own paint shows.
func (e *SevenTVEvents) SetUser(twitchUserID string) {
	e.mu.Lock()
	e.userID = twitchUserID
	e.mu.Unlock()
}

// Joined lists the channels currently followed.
func (e *SevenTVEvents) Joined() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	ids := make([]string, 0, len(e.channels))
	for id := range e.channels {
		ids = append(ids, id)
	}
	return ids
}

func (e *SevenTVEvents) Join(channelID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.channels[channelID]; ok {
		return
	}
	e.channels[channelID] = struct{}{}
	if !e.enabled {
		return
	}
	if e.conn != nil {
		go e.subscribe(e.connCtx, e.conn, e.sessionID, channelID)
	}
	e.start()
}

// SetEnabled opens the socket for the joined channels or closes it. Off
// also skips the account lookup and presence, so 7TV hears nothing.
func (e *SevenTVEvents) SetEnabled(on bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if on == e.enabled {
		return
	}
	e.enabled = on
	if !on {
		if e.stop != nil {
			e.stop()
		}
		e.Log.Info().Msg("7tv events off")
		return
	}
	if len(e.channels) > 0 {
		e.start()
	}
	e.Log.Info().Msg("7tv events on")
}

func (e *SevenTVEvents) Enabled() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.enabled
}

// start runs the connection loop unless it already runs. The loop rechecks
// the switch and the channels on every pass, so one still winding down
// after an off picks up the new state rather than a second loop starting.
// Called with mu held.
func (e *SevenTVEvents) start() {
	if !e.running {
		e.running = true
		go e.run()
	}
}

func (e *SevenTVEvents) Leave(channelID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.channels[channelID]; !ok {
		return
	}
	delete(e.channels, channelID)
	if len(e.channels) == 0 {
		if e.stop != nil {
			e.stop()
		}
		return
	}
	if e.conn == nil {
		return
	}
	ctx, conn := e.connCtx, e.conn
	go func() {
		for _, topic := range sevenTVChannelTopics {
			if err := e.send(ctx, conn, opUnsubscribe, topic, channelID); err != nil {
				e.Log.Debug().Err(err).Str("channel", channelID).Msg("7tv unsubscribe failed")
				return
			}
		}
	}()
}

func (e *SevenTVEvents) run() {
	bo := backoff.New(time.Second, time.Minute)
	for {
		e.mu.Lock()
		if !e.enabled || len(e.channels) == 0 || e.ctx.Err() != nil {
			e.running = false
			e.mu.Unlock()
			return
		}
		connCtx, stop := context.WithCancel(e.ctx)
		e.stop = stop
		e.mu.Unlock()

		greeted, err := e.connectAndListen(connCtx)
		stop()

		e.mu.Lock()
		e.conn, e.connCtx = nil, nil
		e.sessionID = ""
		e.mu.Unlock()

		if connCtx.Err() != nil {
			continue
		}
		if greeted {
			bo.Reset()
		}
		if errors.Is(err, errSevenTVReconnect) {
			continue
		}
		e.Log.Warn().Err(err).Msg("7tv events disconnected, reconnecting")
		select {
		case <-e.ctx.Done():
		case <-time.After(bo.Next()):
		}
	}
}

var errSevenTVReconnect = errors.New("7tv asked to reconnect")

type sevenTVMessage struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
}

func (e *SevenTVEvents) connectAndListen(ctx context.Context) (bool, error) {
	url := e.URL
	if url == "" {
		url = sevenTVEventsURL
	}
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return false, fmt.Errorf("dial %s: %w", url, err)
	}
	defer func() { _ = conn.CloseNow() }()
	// Personal emote set updates arrive unasked and can pass the 32 KiB
	// default.
	conn.SetReadLimit(1 << 20)

	helloCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	var msg sevenTVMessage
	err = readSevenTV(helloCtx, conn, &msg)
	cancel()
	if err != nil {
		return false, fmt.Errorf("read hello: %w", err)
	}
	var hello struct {
		HeartbeatInterval int    `json:"heartbeat_interval"`
		SessionID         string `json:"session_id"`
	}
	if msg.Op != opHello {
		return false, fmt.Errorf("expected hello, got op %d", msg.Op)
	}
	if err := json.Unmarshal(msg.D, &hello); err != nil || hello.HeartbeatInterval <= 0 {
		return false, fmt.Errorf("bad hello: %s", msg.D)
	}

	e.mu.Lock()
	e.conn, e.connCtx = conn, ctx
	e.sessionID = hello.SessionID
	for id := range e.channels {
		go e.subscribe(ctx, conn, hello.SessionID, id)
	}
	e.mu.Unlock()
	e.Log.Info().Str("session", hello.SessionID).Msg("connected to 7tv events")

	// The server sends a heartbeat every interval; two missed means the
	// socket is dead.
	timeout := 2 * time.Duration(hello.HeartbeatInterval) * time.Millisecond
	for {
		readCtx, cancel := context.WithTimeout(ctx, timeout)
		err := readSevenTV(readCtx, conn, &msg)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return true, ctx.Err()
			}
			return true, fmt.Errorf("read: %w", err)
		}
		switch msg.Op {
		case opDispatch:
			handleSevenTVDispatch(msg.D, e.Notify, e.Log)
		case opReconnect:
			return true, errSevenTVReconnect
		case opEndOfStream:
			return true, fmt.Errorf("end of stream: %s", msg.D)
		case opError:
			e.Log.Warn().RawJSON("error", msg.D).Msg("7tv events error")
		}
	}
}

func readSevenTV(ctx context.Context, conn *websocket.Conn, msg *sevenTVMessage) error {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	*msg = sevenTVMessage{}
	return json.Unmarshal(data, msg)
}

func (e *SevenTVEvents) send(ctx context.Context, conn *websocket.Conn, op int, topic, channelID string) error {
	data, err := json.Marshal(map[string]any{
		"op": op,
		"d": map[string]any{
			"type":      topic,
			"condition": map[string]string{"ctx": "channel", "platform": "TWITCH", "id": channelID},
		},
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

// subscribe runs on the connection's context, so switching paints off
// part way through cancels the lookup and presence as well.
func (e *SevenTVEvents) subscribe(ctx context.Context, conn *websocket.Conn, sessionID, channelID string) {
	for _, topic := range sevenTVChannelTopics {
		if err := e.send(ctx, conn, opSubscribe, topic, channelID); err != nil {
			e.Log.Debug().Err(err).Str("channel", channelID).Msg("7tv subscribe failed")
			return
		}
	}
	selfID := e.selfSevenTVID(ctx)
	if selfID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := e.API.SendSelfPresence(ctx, selfID, channelID, sessionID); err != nil {
		e.Log.Warn().Err(err).Str("channel", channelID).Msg("7tv presence failed")
	}
}

// selfSevenTVID looks up (once per signed-in user) the 7TV account linked
// to them; "" when there is none or the lookup failed.
func (e *SevenTVEvents) selfSevenTVID(ctx context.Context) string {
	e.mu.Lock()
	userID := e.userID
	e.mu.Unlock()
	if userID == "" {
		return ""
	}

	e.selfMu.Lock()
	defer e.selfMu.Unlock()
	if e.selfLooked && e.selfFor == userID {
		return e.selfID
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	id, err := e.API.FetchUserID(ctx, userID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		e.Log.Warn().Err(err).Msg("7tv user lookup failed")
		return ""
	}
	e.selfFor, e.selfID, e.selfLooked = userID, id, true
	return id
}

type sevenTVDispatch struct {
	Type string `json:"type"`
	Body struct {
		ID     string `json:"id"`
		Object struct {
			Kind  string          `json:"kind"`
			RefID string          `json:"ref_id"`
			Data  json.RawMessage `json:"data"`
			User  struct {
				ID          string `json:"id"`
				Connections []struct {
					ID       string `json:"id"`
					Platform string `json:"platform"`
				} `json:"connections"`
			} `json:"user"`
		} `json:"object"`
	} `json:"body"`
}

// sevenTVPaint is the paint object inside `cosmetic.create`. Colors are
// RGBA packed into a signed 32-bit int; a null color means "use the chat
// color". Only the top-level fields are read: every paint in the live
// catalogue fills them, `gradients` was always empty.
type sevenTVPaint struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Color    *int64  `json:"color"`
	Function string  `json:"function"`
	Repeat   bool    `json:"repeat"`
	Angle    float64 `json:"angle"`
	Shape    string  `json:"shape"`
	ImageURL string  `json:"image_url"`
	Stops    []struct {
		At    float64 `json:"at"`
		Color int64   `json:"color"`
	} `json:"stops"`
	Shadows []struct {
		XOffset float64 `json:"x_offset"`
		YOffset float64 `json:"y_offset"`
		Radius  float64 `json:"radius"`
		Color   int64   `json:"color"`
	} `json:"shadows"`
}

func handleSevenTVDispatch(raw json.RawMessage, notify func(string, any), log zerolog.Logger) {
	var d sevenTVDispatch
	if err := json.Unmarshal(raw, &d); err != nil {
		log.Debug().Err(err).Msg("bad 7tv dispatch")
		return
	}
	obj := d.Body.Object
	switch d.Type {
	case "cosmetic.create":
		if obj.Kind != "PAINT" {
			return
		}
		var p sevenTVPaint
		if err := json.Unmarshal(obj.Data, &p); err != nil {
			log.Debug().Err(err).Msg("bad 7tv paint")
			return
		}
		if paint, ok := p.normalize(); ok {
			notify("seventv_paint", paint)
		}
	case "entitlement.create", "entitlement.delete":
		if obj.Kind != "PAINT" {
			return
		}
		action := "create"
		if d.Type == "entitlement.delete" {
			action = "delete"
		}
		for _, c := range obj.User.Connections {
			if c.Platform != "TWITCH" {
				continue
			}
			notify("seventv_entitlement", PaintEntitlement{
				Action:    action,
				UserID:    c.ID,
				SevenTVID: obj.User.ID,
				PaintID:   obj.RefID,
			})
		}
	case "entitlement.reset":
		// The body is the 7TV user whose entitlements were dropped
		// (src/worker/event-handlers/handler.ts in the extension).
		if d.Body.ID != "" {
			notify("seventv_entitlement", PaintEntitlement{Action: "reset", SevenTVID: d.Body.ID})
		}
	}
}

func (p sevenTVPaint) normalize() (Paint, bool) {
	switch p.Function {
	case "LINEAR_GRADIENT", "RADIAL_GRADIENT":
		if len(p.Stops) == 0 {
			return Paint{}, false
		}
	case "URL":
		if p.ImageURL == "" {
			return Paint{}, false
		}
	default:
		return Paint{}, false
	}
	out := Paint{
		ID:       p.ID,
		Name:     p.Name,
		Function: p.Function,
		Angle:    p.Angle,
		Shape:    p.Shape,
		ImageURL: p.ImageURL,
		Repeat:   p.Repeat,
		Stops:    make([]PaintStop, 0, len(p.Stops)),
		Shadows:  make([]PaintShadow, 0, len(p.Shadows)),
	}
	// The extension treats 0 like null here: inherit the chat color.
	if p.Color != nil && *p.Color != 0 {
		out.Color = sevenTVColor(*p.Color)
	}
	for _, s := range p.Stops {
		out.Stops = append(out.Stops, PaintStop{At: s.At, Color: sevenTVColor(s.Color)})
	}
	for _, s := range p.Shadows {
		out.Shadows = append(out.Shadows, PaintShadow{X: s.XOffset, Y: s.YOffset, Radius: s.Radius, Color: sevenTVColor(s.Color)})
	}
	return out, true
}

// sevenTVColor turns 7TV's signed RGBA int (red in the top byte) into CSS
// `#rrggbbaa`.
func sevenTVColor(c int64) string {
	return fmt.Sprintf("#%08x", uint32(c))
}
