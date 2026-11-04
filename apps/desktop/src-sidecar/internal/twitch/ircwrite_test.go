package twitch

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// fakeTMI plays Twitch's side of a signed-in IRC connection. answer decides
// what Twitch says back to each PRIVMSG.
type fakeTMI struct {
	t      *testing.T
	answer func(channel, text string) []string
	refuse bool
	// noJoin leaves JOINs unanswered; hangUp closes the socket on PRIVMSG;
	// ping sends a PING before each answer.
	noJoin bool
	hangUp bool
	ping   bool

	mu    sync.Mutex
	dials int
	got   []string
}

// dial connects over loopback TCP: unlike net.Pipe it buffers, as a real
// socket does, so both ends can write at once.
func (f *fakeTMI) dial(ctx context.Context, _ string) (net.Conn, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer func() { _ = ln.Close() }()
	accepted := make(chan net.Conn, 1)
	go func() {
		if c, err := ln.Accept(); err == nil {
			accepted <- c
		}
		close(accepted)
	}()
	client, err := (&net.Dialer{}).DialContext(ctx, "tcp", ln.Addr().String())
	if err != nil {
		return nil, err
	}
	server, ok := <-accepted
	if !ok {
		_ = client.Close()
		return nil, errors.New("fake tmi: accept failed")
	}
	f.mu.Lock()
	f.dials++
	f.mu.Unlock()
	go f.serve(server)
	return client, nil
}

func (f *fakeTMI) serve(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	rd := bufio.NewReader(conn)
	send := func(lines ...string) {
		for _, l := range lines {
			if _, err := conn.Write([]byte(l + "\r\n")); err != nil {
				return
			}
		}
	}
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		f.mu.Lock()
		f.got = append(f.got, line)
		f.mu.Unlock()
		switch {
		case strings.HasPrefix(line, "NICK "):
			if f.refuse {
				send(":tmi.twitch.tv NOTICE * :Login authentication failed")
				continue
			}
			send(":tmi.twitch.tv 001 viewer :Welcome, GLHF!")
		case strings.HasPrefix(line, "JOIN #"):
			if f.noJoin {
				continue
			}
			ch := strings.TrimPrefix(line, "JOIN #")
			send(
				":viewer!viewer@viewer.tmi.twitch.tv JOIN #"+ch,
				"@badge-info=;color=#FF0000 :tmi.twitch.tv USERSTATE #"+ch,
			)
		case strings.Contains(line, "PRIVMSG #"):
			f.mu.Lock()
			hangUp, ping := f.hangUp, f.ping
			f.mu.Unlock()
			if hangUp {
				return
			}
			if ping {
				send("PING :tmi.twitch.tv")
			}
			_, rest, _ := strings.Cut(line, "PRIVMSG #")
			ch, text, _ := strings.Cut(rest, " :")
			send(f.answer(ch, text)...)
		}
	}
}

func (f *fakeTMI) lines() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.got...)
}

func newWriter(f *fakeTMI) *ChatWriter {
	return &ChatWriter{Dial: f.dial, Log: zerolog.Nop()}
}

func TestChatWriterReturnsTheSentMessageID(t *testing.T) {
	f := &fakeTMI{t: t, answer: func(ch, _ string) []string {
		return []string{
			// Other people's chat and a stray answer for another channel
			// must not be taken for this one.
			"@id=x :someone!someone@someone.tmi.twitch.tv PRIVMSG #" + ch + " :hello",
			"@id=wrong :tmi.twitch.tv USERSTATE #elsewhere",
			"@badge-info=;id=m1 :tmi.twitch.tv USERSTATE #" + ch,
		}
	}}
	w := newWriter(f)
	defer w.Close()

	got, err := w.Send(context.Background(), "viewer", "tok", "Caedrel", "hi\nthere", "parent-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.MessageID != "m1" {
		t.Fatalf("message id = %q", got.MessageID)
	}
	lines := f.lines()
	if lines[1] != "PASS oauth:tok" || lines[2] != "NICK viewer" {
		t.Fatalf("handshake = %q", lines[:3])
	}
	if last := lines[len(lines)-1]; last != "@reply-parent-msg-id=parent-1 PRIVMSG #caedrel :hi there" {
		t.Fatalf("sent %q", last)
	}
}

func TestChatWriterReportsWhyTwitchRefused(t *testing.T) {
	f := &fakeTMI{t: t, answer: func(ch, _ string) []string {
		return []string{"@msg-id=msg_duplicate :tmi.twitch.tv NOTICE #" + ch + " :Your message was not sent because it is identical to the previous one you sent, less than 30 seconds ago."}
	}}
	w := newWriter(f)
	defer w.Close()

	got, err := w.Send(context.Background(), "viewer", "tok", "caedrel", "same", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.DropCode != "msg_duplicate" || !strings.HasPrefix(got.DropMessage, "Your message was not sent") {
		t.Fatalf("got %+v", got)
	}
}

func TestChatWriterGivesUpOnASilentDrop(t *testing.T) {
	prev := ircAnswerTimeout
	ircAnswerTimeout = 50 * time.Millisecond
	defer func() { ircAnswerTimeout = prev }()

	f := &fakeTMI{t: t, answer: func(string, string) []string { return nil }}
	w := newWriter(f)
	defer w.Close()

	if _, err := w.Send(context.Background(), "viewer", "tok", "caedrel", "lost", ""); !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v", err)
	}
}

func TestChatWriterSurfacesARefusedLogin(t *testing.T) {
	f := &fakeTMI{t: t, refuse: true}
	w := newWriter(f)
	defer w.Close()

	_, err := w.Send(context.Background(), "viewer", "bad", "caedrel", "hi", "")
	if !errors.Is(err, ErrLoginRefused) || !strings.Contains(err.Error(), "Login authentication failed") {
		t.Fatalf("err = %v", err)
	}
}

func TestChatWriterReusesTheConnectionUntilTheTokenChanges(t *testing.T) {
	f := &fakeTMI{t: t, answer: func(ch, _ string) []string {
		return []string{"@id=m :tmi.twitch.tv USERSTATE #" + ch}
	}}
	w := newWriter(f)
	defer w.Close()

	for _, token := range []string{"a", "a", "b"} {
		if _, err := w.Send(context.Background(), "viewer", token, "caedrel", "hi", ""); err != nil {
			t.Fatal(err)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dials != 2 {
		t.Fatalf("dials = %d", f.dials)
	}
	joins := 0
	for _, l := range f.got {
		if l == "JOIN #caedrel" {
			joins++
		}
	}
	if joins != 2 {
		t.Fatalf("joins = %d", joins)
	}
}

func ok(ch, _ string) []string {
	return []string{"@id=m :tmi.twitch.tv USERSTATE #" + ch}
}

func TestChatWriterRedialsAfterTheConnectionDrops(t *testing.T) {
	f := &fakeTMI{t: t, answer: ok, hangUp: true}
	w := newWriter(f)
	defer w.Close()

	if _, err := w.Send(context.Background(), "viewer", "tok", "caedrel", "hi", ""); err == nil {
		t.Fatal("a dropped connection reported success")
	}
	f.mu.Lock()
	f.hangUp = false
	f.mu.Unlock()
	if _, err := w.Send(context.Background(), "viewer", "tok", "caedrel", "hi", ""); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dials != 2 {
		t.Fatalf("dials = %d", f.dials)
	}
}

func TestChatWriterAnswersPingsWhileWaiting(t *testing.T) {
	f := &fakeTMI{t: t, answer: ok, ping: true}
	w := newWriter(f)
	defer w.Close()

	if _, err := w.Send(context.Background(), "viewer", "tok", "caedrel", "hi", ""); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, l := range f.lines() {
			if l == "PONG :tmi.twitch.tv" {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no PONG")
}

func TestChatWriterStopsWhenTheCallerGivesUp(t *testing.T) {
	f := &fakeTMI{t: t, answer: func(string, string) []string { return nil }}
	w := newWriter(f)
	defer w.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := w.Send(ctx, "viewer", "tok", "caedrel", "hi", ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

func TestChatWriterReportsAJoinTwitchNeverAnswered(t *testing.T) {
	prev := ircJoinTimeout
	ircJoinTimeout = 30 * time.Millisecond
	defer func() { ircJoinTimeout = prev }()

	f := &fakeTMI{t: t, answer: ok, noJoin: true}
	w := newWriter(f)
	defer w.Close()

	_, err := w.Send(context.Background(), "viewer", "tok", "caedrel", "hi", "")
	if err == nil || !strings.Contains(err.Error(), "join caedrel") {
		t.Fatalf("err = %v", err)
	}
}

func TestChatWriterReportsAFailedDial(t *testing.T) {
	w := &ChatWriter{
		Dial: func(context.Context, string) (net.Conn, error) { return nil, errors.New("offline") },
		Log:  zerolog.Nop(),
	}
	if _, err := w.Send(context.Background(), "viewer", "tok", "caedrel", "hi", ""); err == nil || !strings.Contains(err.Error(), "offline") {
		t.Fatalf("err = %v", err)
	}
}
