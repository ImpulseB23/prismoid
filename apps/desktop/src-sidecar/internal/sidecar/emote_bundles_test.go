package sidecar

import (
	"context"
	"sync"
	"testing"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
	"github.com/ImpulseB23/Prismoid/sidecar/internal/twitch"
)

func idleBundles() *emoteBundles {
	return newEmoteBundles(func(string, any) {}, zerolog.Nop())
}

type bundleFetch struct {
	ctx     context.Context
	cmd     control.Command
	sevenTV bool
}

// recordFetches swaps emoteFetchFn for one that records each call, and
// waits for `n` of them.
func recordFetches(t *testing.T) func(n int) []bundleFetch {
	t.Helper()
	var mu sync.Mutex
	var calls []bundleFetch
	changed := make(chan struct{}, 64)
	orig := emoteFetchFn
	emoteFetchFn = func(ctx context.Context, cmd control.Command, sevenTV bool, _ twitch.Notify, _ zerolog.Logger) {
		mu.Lock()
		calls = append(calls, bundleFetch{ctx, cmd, sevenTV})
		mu.Unlock()
		changed <- struct{}{}
	}
	t.Cleanup(func() { emoteFetchFn = orig })
	return func(n int) []bundleFetch {
		t.Helper()
		for {
			mu.Lock()
			got := len(calls)
			out := append([]bundleFetch(nil), calls...)
			mu.Unlock()
			if got >= n {
				return out
			}
			<-changed
		}
	}
}

func TestEmoteBundlesRefetchWhenSevenTVFlips(t *testing.T) {
	wait := recordFetches(t)
	b := idleBundles()
	b.join(context.Background(), control.Command{BroadcasterID: "1", Token: "old"})
	b.join(context.Background(), control.Command{BroadcasterID: "2", Token: "old"})
	first := wait(2)
	if !first[0].sevenTV || !first[1].sevenTV {
		t.Fatal("bundles start with 7TV")
	}

	b.setToken("new")
	b.part("2")
	b.setSevenTV(false)
	b.setSevenTV(false)
	calls := wait(3)
	if len(calls) != 3 {
		t.Fatalf("expected one refetch for the joined channel, got %d calls", len(calls))
	}
	again := calls[2]
	if again.sevenTV || again.cmd.BroadcasterID != "1" || again.cmd.Token != "new" {
		t.Fatalf("refetch = %+v", again)
	}
	for _, c := range first {
		if c.cmd.BroadcasterID == "1" && c.ctx.Err() == nil {
			t.Fatal("the older fetch must be cancelled so it never lands last")
		}
	}
	if again.ctx.Err() != nil {
		t.Fatal("the new fetch must still run")
	}
}

func TestBuildFetcherLeavesSevenTVOutWhenOff(t *testing.T) {
	if f := buildFetcher(control.Command{}, false); f.SevenTV != nil || f.BTTV == nil || f.FFZ == nil {
		t.Fatalf("fetcher = %+v", f)
	}
	if f := buildFetcher(control.Command{}, true); f.SevenTV == nil {
		t.Fatal("7TV client missing while on")
	}
}

func TestDispatchCommand_RoutesSevenTVEmotes(t *testing.T) {
	wait := recordFetches(t)
	b := idleBundles()
	b.join(context.Background(), control.Command{BroadcasterID: "1"})
	wait(1)
	DispatchCommand(context.Background(), control.Command{Cmd: "seventv_emotes", Enabled: false}, map[string]context.CancelFunc{}, idleSession(t), idleFirsts(), idleCosmetics(t), b, make(chan []byte, 1), func(string, any) {}, zerolog.Nop())
	if calls := wait(2); calls[1].sevenTV {
		t.Fatal("seventv_emotes did not reach the bundles")
	}
	DispatchCommand(context.Background(), control.Command{Cmd: "token_refresh", Token: "fresh"}, map[string]context.CancelFunc{}, idleSession(t), idleFirsts(), idleCosmetics(t), b, make(chan []byte, 1), func(string, any) {}, zerolog.Nop())
	if b.channels["1"].cmd.Token != "fresh" {
		t.Fatal("token_refresh must reach the bundles")
	}
}
