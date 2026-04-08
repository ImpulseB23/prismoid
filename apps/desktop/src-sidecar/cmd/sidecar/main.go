package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
	"github.com/ImpulseB23/Prismoid/sidecar/internal/ringbuf"
	"github.com/ImpulseB23/Prismoid/sidecar/internal/twitch"
)

func main() {
	zerolog.SetGlobalLevel(zerolog.DebugLevel)
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	log.Info().Msg("sidecar starting")

	stdin := bufio.NewScanner(os.Stdin)
	cmdCh := make(chan control.Command, 16)

	go func() {
		for stdin.Scan() {
			var cmd control.Command
			if err := json.Unmarshal(stdin.Bytes(), &cmd); err != nil {
				log.Error().Err(err).Msg("invalid command from host")
				continue
			}
			cmdCh <- cmd
		}
	}()

	heartbeat := time.NewTicker(1 * time.Second)
	defer heartbeat.Stop()

	encoder := json.NewEncoder(os.Stdout)
	clients := make(map[string]context.CancelFunc)

	notify := func(msgType string, payload any) {
		if err := encoder.Encode(control.Message{Type: msgType, Payload: payload}); err != nil {
			log.Error().Err(err).Str("type", msgType).Msg("failed to notify host")
		}
	}

	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("sidecar shutting down")
			return
		case <-heartbeat.C:
			if err := encoder.Encode(control.Message{Type: "heartbeat"}); err != nil {
				log.Error().Err(err).Msg("failed to write heartbeat to host")
				return
			}
		case cmd := <-cmdCh:
			switch cmd.Cmd {
			case "twitch_connect":
				handleTwitchConnect(ctx, cmd, clients, notify)
			case "twitch_disconnect":
				handleTwitchDisconnect(cmd, clients)
			default:
				log.Info().Str("cmd", cmd.Cmd).Str("channel", cmd.Channel).Msg("received command")
			}
		}
	}
}

func handleTwitchConnect(ctx context.Context, cmd control.Command, clients map[string]context.CancelFunc, notify twitch.Notify) {
	if _, exists := clients[cmd.BroadcasterID]; exists {
		log.Warn().Str("broadcaster", cmd.BroadcasterID).Msg("already connected, ignoring")
		return
	}

	mem, cleanup, err := ringbuf.OpenShared(cmd.ShmName, cmd.ShmSize)
	if err != nil {
		log.Error().Err(err).Str("shm", cmd.ShmName).Msg("failed to open shared memory")
		return
	}

	writer, err := ringbuf.Open(mem)
	if err != nil {
		cleanup()
		log.Error().Err(err).Msg("failed to open ring buffer writer")
		return
	}

	clientCtx, clientCancel := context.WithCancel(ctx)

	client := &twitch.Client{
		BroadcasterID: cmd.BroadcasterID,
		UserID:        cmd.UserID,
		AccessToken:   cmd.Token,
		ClientID:      cmd.ClientID,
		Writer:        writer,
		Log:           log.With().Str("broadcaster", cmd.BroadcasterID).Logger(),
		Notify:        notify,
	}

	clients[cmd.BroadcasterID] = func() {
		clientCancel()
		cleanup()
	}

	go func() {
		if err := client.Run(clientCtx); err != nil && ctx.Err() == nil {
			log.Error().Err(err).Str("broadcaster", cmd.BroadcasterID).Msg("twitch client exited")
		}
	}()

	log.Info().Str("broadcaster", cmd.BroadcasterID).Msg("twitch client started")
}

func handleTwitchDisconnect(cmd control.Command, clients map[string]context.CancelFunc) {
	cancelFn, exists := clients[cmd.BroadcasterID]
	if !exists {
		log.Warn().Str("broadcaster", cmd.BroadcasterID).Msg("no active connection to disconnect")
		return
	}
	cancelFn()
	delete(clients, cmd.BroadcasterID)
	log.Info().Str("broadcaster", cmd.BroadcasterID).Msg("twitch client disconnected")
}
