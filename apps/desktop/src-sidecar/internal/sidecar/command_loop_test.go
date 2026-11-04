package sidecar

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
)

// A send waiting on Twitch used to block the loop, so the host saw no
// heartbeat, killed the sidecar as hung and failed every pending command.
func TestSlowSendDoesNotStallHeartbeats(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"message_id":"m1","is_sent":true}]}`))
	}))
	defer srv.Close()
	prev := twitchHelixBase
	twitchHelixBase = srv.URL
	defer func() { twitchHelixBase = prev }()

	cmd := `{"cmd":"send_chat_message","request_id":7,"broadcaster_id":"b","user_id":"u","client_id":"c","token":"t","message":"hi"}` + "\n"
	stdoutR, stdoutW := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- RunCommandLoop(ctx, bufio.NewScanner(strings.NewReader(cmd)), json.NewEncoder(stdoutW), make(chan []byte, 16), zerolog.Nop(), 10*time.Millisecond)
	}()
	defer func() {
		cancel()
		_ = stdoutR.Close()
		<-done
	}()

	dec := json.NewDecoder(stdoutR)
	next := func() control.Message {
		var m control.Message
		if err := dec.Decode(&m); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return m
	}

	for beats := 0; beats < 5; {
		switch m := next(); m.Type {
		case "heartbeat":
			beats++
		case "send_chat_result":
			t.Fatal("send answered before Twitch replied")
		}
	}
	close(release)
	for next().Type != "send_chat_result" {
	}
}
