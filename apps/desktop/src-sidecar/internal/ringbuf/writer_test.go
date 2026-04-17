package ringbuf

import (
	"encoding/binary"
	"sync/atomic"
	"testing"
	"unsafe"
)

func makeBuf(capacity int) []byte {
	mem := make([]byte, headerSize+capacity)
	*(*uint64)(unsafe.Pointer(&mem[cacheLine*2])) = uint64(capacity)
	return mem
}

func TestOpenValidatesSize(t *testing.T) {
	_, err := Open(make([]byte, 10))
	if err == nil {
		t.Fatal("expected error for small buffer")
	}
}

func TestOpenValidatesCapacity(t *testing.T) {
	mem := make([]byte, headerSize+64)
	_, err := Open(mem)
	if err == nil {
		t.Fatal("expected error for zero capacity")
	}
}

func TestWriteSingleMessage(t *testing.T) {
	mem := makeBuf(4096)
	w, err := Open(mem)
	if err != nil {
		t.Fatal(err)
	}

	ok := w.Write([]byte("hello"))
	if !ok {
		t.Fatal("write returned false")
	}

	writePos := atomic.LoadUint64(w.writeIndex())
	if writePos != 4+5 {
		t.Fatalf("expected write_index=9, got %d", writePos)
	}

	data := mem[headerSize:]
	msgLen := binary.BigEndian.Uint32(data[0:4])
	if msgLen != 5 {
		t.Fatalf("expected length=5, got %d", msgLen)
	}

	payload := string(data[4:9])
	if payload != "hello" {
		t.Fatalf("expected payload='hello', got '%s'", payload)
	}
}

func TestWriteMultipleMessages(t *testing.T) {
	mem := makeBuf(4096)
	w, err := Open(mem)
	if err != nil {
		t.Fatal(err)
	}

	messages := []string{"msg1", "msg two", "third message"}
	for _, msg := range messages {
		if !w.Write([]byte(msg)) {
			t.Fatalf("write failed for %q", msg)
		}
	}

	data := mem[headerSize:]
	offset := 0
	for i, expected := range messages {
		msgLen := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		offset += 4
		got := string(data[offset : offset+msgLen])
		if got != expected {
			t.Fatalf("message %d: expected %q, got %q", i, expected, got)
		}
		offset += msgLen
	}
}

func TestWriteRejectsEmptyPayload(t *testing.T) {
	mem := makeBuf(64)
	w, err := Open(mem)
	if err != nil {
		t.Fatal(err)
	}
	if w.Write(nil) {
		t.Fatal("nil payload should be rejected")
	}
	if w.Write([]byte{}) {
		t.Fatal("empty payload should be rejected")
	}
}

func TestWriteRejectsPayloadLargerThanCapacity(t *testing.T) {
	mem := makeBuf(32)
	w, err := Open(mem)
	if err != nil {
		t.Fatal(err)
	}
	// 4 (length) + 32 (payload) > 32 cap, eviction can never make room.
	if w.Write(make([]byte, 32)) {
		t.Fatal("oversized payload should be rejected")
	}
}

func TestWriteEvictsOldestWhenFull(t *testing.T) {
	mem := makeBuf(32)
	w, err := Open(mem)
	if err != nil {
		t.Fatal(err)
	}

	// First write: 4 + 12 = 16 bytes, fits.
	if !w.Write([]byte("AAAAAAAAAAAA")) {
		t.Fatal("first write should succeed")
	}
	// Second write: 4 + 12 = 16 bytes, fills the ring exactly.
	if !w.Write([]byte("BBBBBBBBBBBB")) {
		t.Fatal("second write should succeed")
	}

	if got := atomic.LoadUint64(w.minReadIndex()); got != 0 {
		t.Fatalf("min_read_pos should still be 0, got %d", got)
	}

	// Third write needs 16 bytes; reader is idle so the writer must evict
	// the first frame (16 bytes) to make room.
	if !w.Write([]byte("CCCCCCCCCCCC")) {
		t.Fatal("third write should succeed via eviction")
	}

	if got := atomic.LoadUint64(w.minReadIndex()); got != 16 {
		t.Fatalf("expected min_read_pos=16 after evicting one frame, got %d", got)
	}
	if got := atomic.LoadUint64(w.droppedFrames()); got != 1 {
		t.Fatalf("expected dropped_frames=1, got %d", got)
	}
	if got := atomic.LoadUint64(w.writeIndex()); got != 48 {
		t.Fatalf("expected write_index=48, got %d", got)
	}
}

func TestWriteEvictsMultipleFramesWhenNeeded(t *testing.T) {
	mem := makeBuf(64)
	w, err := Open(mem)
	if err != nil {
		t.Fatal(err)
	}

	// Four 12-byte payloads = four 16-byte frames, exactly fills 64.
	for i := 0; i < 4; i++ {
		if !w.Write([]byte("xxxxxxxxxxxx")) {
			t.Fatalf("write %d should succeed", i)
		}
	}

	// One 28-byte payload = 32-byte frame; writer must evict 2 frames.
	if !w.Write(make([]byte, 28)) {
		t.Fatal("large write should succeed via eviction")
	}

	if got := atomic.LoadUint64(w.droppedFrames()); got != 2 {
		t.Fatalf("expected dropped_frames=2, got %d", got)
	}
	if got := atomic.LoadUint64(w.minReadIndex()); got != 32 {
		t.Fatalf("expected min_read_pos=32, got %d", got)
	}
}

func TestWriteRespectsReaderProgress(t *testing.T) {
	mem := makeBuf(32)
	w, err := Open(mem)
	if err != nil {
		t.Fatal(err)
	}

	if !w.Write([]byte("AAAAAAAAAAAA")) {
		t.Fatal("first write should succeed")
	}
	if !w.Write([]byte("BBBBBBBBBBBB")) {
		t.Fatal("second write should succeed")
	}

	// Reader caught up to the first frame; writer should not need to evict.
	atomic.StoreUint64(w.readIndex(), 16)

	if !w.Write([]byte("CCCCCCCCCCCC")) {
		t.Fatal("third write should succeed without eviction")
	}
	if got := atomic.LoadUint64(w.droppedFrames()); got != 0 {
		t.Fatalf("expected no drops when reader has progressed, got %d", got)
	}
}

func TestOpenValidatesMemSizeForCapacity(t *testing.T) {
	mem := make([]byte, headerSize+64)
	// claim capacity of 1024 but buffer only has 64 bytes of data space
	*(*uint64)(unsafe.Pointer(&mem[cacheLine*2])) = 1024
	_, err := Open(mem)
	if err == nil {
		t.Fatal("expected error when mem is too small for declared capacity")
	}
}

func TestWriteWrapsAround(t *testing.T) {
	mem := makeBuf(32)
	w, err := Open(mem)
	if err != nil {
		t.Fatal(err)
	}

	// write 20 bytes (4-byte header + 16-byte payload)
	if !w.Write(make([]byte, 16)) {
		t.Fatal("first write should succeed")
	}

	// simulate reader consuming those 20 bytes
	atomic.StoreUint64(w.readIndex(), 20)

	// write 12-byte payload (framed: 4 + 12 = 16 bytes)
	// write_pos=20, cap=32, offset=20%32=20, firstChunk=12
	// length header (4 bytes at offset 20): fits without wrapping
	// payload (12 bytes at offset 24): firstChunk=8 < 12, wraps around
	payload := []byte("ABCDEFGHIJKL")
	if !w.Write(payload) {
		t.Fatal("wrapped write should succeed")
	}

	data := w.data()

	msgLen := binary.BigEndian.Uint32(data[20:24])
	if msgLen != 12 {
		t.Fatalf("expected length=12, got %d", msgLen)
	}

	// payload: 8 bytes at [24..32), then 4 bytes at [0..4)
	var got [12]byte
	copy(got[:8], data[24:32])
	copy(got[8:], data[0:4])
	if string(got[:]) != "ABCDEFGHIJKL" {
		t.Fatalf("expected 'ABCDEFGHIJKL', got %q", string(got[:]))
	}
}
