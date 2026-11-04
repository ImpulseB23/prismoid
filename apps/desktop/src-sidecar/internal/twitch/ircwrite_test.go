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

	mu    sync.Mutex
	dials int
	got   []string
}

func (f *fakeTMI) dial(_ context.Context, _ string) (net.Conn, error) {
	client, server := net.Pipe()
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
			ch := strings.TrimPrefix(line, "JOIN #")
			send(
				":viewer!viewer@viewer.tmi.twitch.tv JOIN #"+ch,
				"@badge-info=;color=#FF0000 :tmi.twitch.tv USERSTATE #"+ch,
			)
		case strings.Contains(line, "PRIVMSG #"):
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
