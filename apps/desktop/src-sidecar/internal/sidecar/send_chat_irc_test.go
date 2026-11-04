package sidecar

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
	"github.com/ImpulseB23/Prismoid/sidecar/internal/twitch"
)

// tmi answers a signed-in IRC session: login, joins, and each PRIVMSG with
// reply(text).
func tmi(refuseLogin bool, reply func(channel, text string) string) func(context.Context, string) (net.Conn, error) {
	return func(context.Context, string) (net.Conn, error) {
		client, server := net.Pipe()
		go func() {
			defer func() { _ = server.Close() }()
			rd := bufio.NewReader(server)
			for {
				line, err := rd.ReadString('\n')
				if err != nil {
					return
				}
				line = strings.TrimRight(line, "\r\n")
				var out string
				switch {
				case strings.HasPrefix(line, "NICK ") && refuseLogin:
					out = ":tmi.twitch.tv NOTICE * :Login authentication failed"
				case strings.HasPrefix(line, "NICK "):
					out = ":tmi.twitch.tv 001 viewer :Welcome"
				case strings.HasPrefix(line, "JOIN #"):
					out = ":tmi.twitch.tv USERSTATE #" + strings.TrimPrefix(line, "JOIN #")
				case strings.Contains(line, "PRIVMSG #"):
					_, rest, _ := strings.Cut(line, "PRIVMSG #")
					ch, text, _ := strings.Cut(rest, " :")
					out = reply(ch, text)
				}
				if out != "" {
					if _, err := server.Write([]byte(out + "\r\n")); err != nil {
						return
					}
				}
			}
		}()
		return client, nil
	}
}

func sendIRC(t *testing.T, writer *twitch.ChatWriter, cmd control.Command) SendChatResultPayload {
	t.Helper()
	var got SendChatResultPayload
	HandleSendChatIRC(context.Background(), cmd, writer, func(kind string, payload any) {
		if kind != "send_chat_result" {
			t.Fatalf("notified %q", kind)
		}
		got = payload.(SendChatResultPayload)
	}, zerolog.Nop())
	return got
}

func ircCmd(message string) control.Command {
	return control.Command{
		Cmd:       "send_chat_irc",
		RequestID: 4,
		Channel:   "caedrel",
		UserLogin: "viewer",
		Token:     "tok",
		Message:   message,
	}
}

func TestSendChatIRCAnswersWithTwitchsVerdict(t *testing.T) {
	writer := &twitch.ChatWriter{Dial: tmi(false, func(ch, text string) string {
		if text == "again" {
			return "@msg-id=msg_duplicate :tmi.twitch.tv NOTICE #" + ch + " :Your message was not sent because it is identical to the previous one you sent, less than 30 seconds ago."
		}
		return "@id=m9 :tmi.twitch.tv USERSTATE #" + ch
	}), Log: zerolog.Nop()}
	defer writer.Close()

	ok := sendIRC(t, writer, ircCmd("hello"))
	if !ok.Ok || ok.MessageID != "m9" || ok.RequestID != 4 {
		t.Fatalf("sent = %+v", ok)
	}
	dup := sendIRC(t, writer, ircCmd("again"))
	if dup.Ok || dup.DropCode != "msg_duplicate" {
		t.Fatalf("dropped = %+v", dup)
	}
}

func TestSendChatIRCTurnsARefusedLoginIntoA401(t *testing.T) {
	writer := &twitch.ChatWriter{Dial: tmi(true, nil), Log: zerolog.Nop()}
	defer writer.Close()

	got := sendIRC(t, writer, ircCmd("hello"))
	if got.HTTPStatus != http.StatusUnauthorized || got.ErrorMessage == "" {
		t.Fatalf("got %+v", got)
	}
}

func TestSendChatIRCChecksItsInput(t *testing.T) {
	writer := &twitch.ChatWriter{Log: zerolog.Nop()}
	missing := ircCmd("hello")
	missing.UserLogin = ""
	if got := sendIRC(t, writer, missing); got.ErrorMessage == "" {
		t.Fatal("missing login accepted")
	}
	if got := sendIRC(t, writer, ircCmd("")); got.ErrorMessage != "empty message" {
		t.Fatalf("got %+v", got)
	}
	if got := sendIRC(t, writer, ircCmd(strings.Repeat("a", twitch.MaxChatMessageBytes+1))); !strings.Contains(got.ErrorMessage, "exceeds") {
		t.Fatalf("got %+v", got)
	}
}
