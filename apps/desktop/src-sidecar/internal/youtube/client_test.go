package youtube

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
	pb "github.com/ImpulseB23/Prismoid/sidecar/internal/youtube/ytpb"
)

type fakeStreamListServer struct {
	pb.UnimplementedV3DataLiveChatMessageServiceServer
	responses []*pb.LiveChatMessageListResponse
	sendErr   error
}

func (f *fakeStreamListServer) StreamList(_ *pb.LiveChatMessageListRequest, stream pb.V3DataLiveChatMessageService_StreamListServer) error {
	for _, resp := range f.responses {
		if err := stream.Send(resp); err != nil {
			return err
		}
	}
	if f.sendErr != nil {
		return f.sendErr
	}
	<-stream.Context().Done()
	return stream.Context().Err()
}

func startFakeServer(t *testing.T, srvImpl pb.V3DataLiveChatMessageServiceServer) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterV3DataLiveChatMessageServiceServer(srv, srvImpl)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(func() {
		srv.Stop()
		_ = lis.Close()
	})
	return lis.Addr().String()
}

func newTestClient(addr string, out chan []byte) *Client {
	return &Client{
		LiveChatID: "chat-123",
		APIKey:     "test-key",
		Target:     "dns:///" + addr,
		DialOpts:   []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())},
		Out:        out,
		Log:        zerolog.Nop(),
	}
}

func TestClientReceivesTextMessages(t *testing.T) {
	msgType := pb.LiveChatMessageSnippet_TypeWrapper_TEXT_MESSAGE_EVENT
	publishedAt := "2024-06-15T12:30:00Z"
	msgText := "hello from test"
	displayName := "TestUser"
	channelID := "UC_test"

	resp := &pb.LiveChatMessageListResponse{
		Items: []*pb.LiveChatMessage{
			{
				Id: proto.String("msg-1"),
				Snippet: &pb.LiveChatMessageSnippet{
					Type:        &msgType,
					PublishedAt: &publishedAt,
					DisplayedContent: &pb.LiveChatMessageSnippet_TextMessageDetails{
						TextMessageDetails: &pb.LiveChatTextMessageDetails{
							MessageText: &msgText,
						},
					},
				},
				AuthorDetails: &pb.LiveChatMessageAuthorDetails{
					ChannelId:   &channelID,
					DisplayName: &displayName,
				},
			},
		},
	}

	addr := startFakeServer(t, &fakeStreamListServer{responses: []*pb.LiveChatMessageListResponse{resp}})

	out := make(chan []byte, 16)
	client := newTestClient(addr, out)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	select {
	case data := <-out:
		cancel()
		if len(data) < 2 {
			t.Fatal("message too short")
		}
		if data[0] != control.TagYouTube {
			t.Fatalf("expected tag 0x03, got 0x%02x", data[0])
		}
		body := string(data[1:])
		if !strings.Contains(body, "msg-1") {
			t.Errorf("expected message id msg-1 in json: %s", body)
		}
		if !strings.Contains(body, "hello from test") {
			t.Errorf("expected message text in json: %s", body)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for message")
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("client.Run did not exit after cancel")
	}
}

func TestClientStopsOnNotFound(t *testing.T) {
	srv := &fakeStreamListServer{sendErr: status.Error(codes.NotFound, "chat not found")}
	addr := startFakeServer(t, srv)

	out := make(chan []byte, 1)
	client := newTestClient(addr, out)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := client.Run(ctx)
	if err == nil {
		t.Fatal("expected NotFound error, got nil")
	}
	s, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status error, got %T: %v", err, err)
	}
	if s.Code() != codes.NotFound {
		t.Fatalf("expected NotFound, got %s", s.Code())
	}
}

func TestClientRequiresCredentials(t *testing.T) {
	out := make(chan []byte, 1)
	client := &Client{
		LiveChatID: "chat-123",
		Out:        out,
		Log:        zerolog.Nop(),
	}
	err := client.Run(context.Background())
	if !errors.Is(err, ErrMissingCredentials) {
		t.Fatalf("expected ErrMissingCredentials, got %v", err)
	}
}

func TestClientRequiresCredentials_NotifiesAuthError(t *testing.T) {
	out := make(chan []byte, 1)
	var got string
	client := &Client{
		LiveChatID: "chat-123",
		Out:        out,
		Log:        zerolog.Nop(),
		Notify: func(msgType string, _ any) {
			got = msgType
		},
	}
	_ = client.Run(context.Background())
	if got != "auth_error" {
		t.Fatalf("expected auth_error notification, got %q", got)
	}
}

func TestClientStopsOnFailedPrecondition_NotifiesError(t *testing.T) {
	srv := &fakeStreamListServer{sendErr: status.Error(codes.FailedPrecondition, "chat ended")}
	addr := startFakeServer(t, srv)

	out := make(chan []byte, 1)
	client := newTestClient(addr, out)
	var notifyType string
	client.Notify = func(msgType string, _ any) { notifyType = msgType }

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := client.Run(ctx)
	if err == nil {
		t.Fatal("expected error")
	}
	if notifyType != "youtube_error" {
		t.Fatalf("expected youtube_error notification, got %q", notifyType)
	}
}

func TestClientStopsOnPermissionDenied_NotifiesAuthError(t *testing.T) {
	srv := &fakeStreamListServer{sendErr: status.Error(codes.PermissionDenied, "denied")}
	addr := startFakeServer(t, srv)

	out := make(chan []byte, 1)
	client := newTestClient(addr, out)
	var notifyType string
	client.Notify = func(msgType string, _ any) { notifyType = msgType }

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := client.Run(ctx)
	if err == nil {
		t.Fatal("expected error")
	}
	if notifyType != "auth_error" {
		t.Fatalf("expected auth_error notification, got %q", notifyType)
	}
}

func TestClientNotifiesOnOffline(t *testing.T) {
	offlineAt := "2024-06-15T13:00:00Z"
	resp := &pb.LiveChatMessageListResponse{
		OfflineAt: &offlineAt,
	}
	addr := startFakeServer(t, &fakeStreamListServer{responses: []*pb.LiveChatMessageListResponse{resp}})

	out := make(chan []byte, 1)
	client := newTestClient(addr, out)

	notified := make(chan string, 1)
	client.Notify = func(msgType string, _ any) {
		if msgType == "youtube_offline" {
			select {
			case notified <- msgType:
			default:
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() { _ = client.Run(ctx) }()

	select {
	case <-notified:
	case <-ctx.Done():
		t.Fatal("timed out waiting for offline notification")
	}
}

func TestClientUsesAccessTokenAuth(t *testing.T) {
	msgType := pb.LiveChatMessageSnippet_TypeWrapper_TEXT_MESSAGE_EVENT
	publishedAt := "2024-06-15T12:30:00Z"
	resp := &pb.LiveChatMessageListResponse{
		Items: []*pb.LiveChatMessage{{
			Id: proto.String("msg-tok"),
			Snippet: &pb.LiveChatMessageSnippet{
				Type:        &msgType,
				PublishedAt: &publishedAt,
				DisplayedContent: &pb.LiveChatMessageSnippet_TextMessageDetails{
					TextMessageDetails: &pb.LiveChatTextMessageDetails{
						MessageText: proto.String("ok"),
					},
				},
			},
			AuthorDetails: &pb.LiveChatMessageAuthorDetails{
				ChannelId:   proto.String("UC_x"),
				DisplayName: proto.String("X"),
			},
		}},
	}
	addr := startFakeServer(t, &fakeStreamListServer{responses: []*pb.LiveChatMessageListResponse{resp}})

	out := make(chan []byte, 1)
	client := &Client{
		LiveChatID:  "chat-123",
		AccessToken: "oauth-token",
		Target:      "dns:///" + addr,
		DialOpts:    []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())},
		Out:         out,
		Log:         zerolog.Nop(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = client.Run(ctx) }()

	select {
	case <-out:
	case <-ctx.Done():
		t.Fatal("timed out waiting for message via access token auth")
	}
}

func TestClientDropsMessagesWhenChannelFull(t *testing.T) {
	msgType := pb.LiveChatMessageSnippet_TypeWrapper_TEXT_MESSAGE_EVENT
	publishedAt := "2024-06-15T12:30:00Z"
	mkMsg := func(id string) *pb.LiveChatMessage {
		return &pb.LiveChatMessage{
			Id: proto.String(id),
			Snippet: &pb.LiveChatMessageSnippet{
				Type:        &msgType,
				PublishedAt: &publishedAt,
				DisplayedContent: &pb.LiveChatMessageSnippet_TextMessageDetails{
					TextMessageDetails: &pb.LiveChatTextMessageDetails{MessageText: proto.String("x")},
				},
			},
			AuthorDetails: &pb.LiveChatMessageAuthorDetails{
				ChannelId: proto.String("UC"), DisplayName: proto.String("U"),
			},
		}
	}
	nextToken := "page-2"
	resp := &pb.LiveChatMessageListResponse{
		NextPageToken: &nextToken,
		Items:         []*pb.LiveChatMessage{mkMsg("a"), mkMsg("b"), mkMsg("c")},
	}
	addr := startFakeServer(t, &fakeStreamListServer{responses: []*pb.LiveChatMessageListResponse{resp}})

	out := make(chan []byte, 1)
	client := newTestClient(addr, out)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { _ = client.Run(ctx); close(done) }()

	select {
	case <-out:
	case <-ctx.Done():
		t.Fatal("expected at least one message")
	}
	cancel()
	<-done
}
