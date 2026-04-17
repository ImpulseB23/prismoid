package ringbuf

import (
	"encoding/binary"
	"fmt"
	"sync/atomic"
	"unsafe"
)

const (
	cacheLine  = 64
	headerSize = cacheLine * 5
)

// Header layout (5 cache lines):
//
//	[0..64)    write_index    writer-only stores; reader Acquire-loads
//	[64..128)  read_index     reader-only stores; writer Acquire-loads (informational)
//	[128..192) capacity       immutable after init
//	[192..256) min_read_pos   writer-only stores; reader Acquire-loads (drop-oldest floor)
//	[256..320) dropped_frames writer-only stores; reader Acquire-loads (monotonic counter)
//
// Drop-oldest semantics: when a Write would not fit, the writer evicts the
// oldest already-written frames by parsing their length prefixes and advancing
// min_read_pos past them. The reader observes min_read_pos on every drain and
// snaps its own read cursor forward, then re-checks min_read_pos after copying
// each frame to detect clobber-races. dropped_frames is monotonic so the host
// can compute a per-tick delta. See docs/architecture.md "Backpressure".
type Writer struct {
	mem      []byte
	capacity uint64
}

func Open(mem []byte) (*Writer, error) {
	if len(mem) < headerSize {
		return nil, fmt.Errorf("shared memory too small: %d bytes, need at least %d", len(mem), headerSize)
	}

	capacity := *(*uint64)(unsafe.Pointer(&mem[cacheLine*2]))
	if capacity == 0 {
		return nil, fmt.Errorf("ring buffer not initialized (capacity is 0)")
	}

	if uint64(len(mem)) < uint64(headerSize)+capacity {
		return nil, fmt.Errorf("shared memory size %d too small for capacity %d", len(mem), capacity)
	}

	return &Writer{mem: mem, capacity: capacity}, nil
}

func (w *Writer) writeIndex() *uint64 {
	return (*uint64)(unsafe.Pointer(&w.mem[0]))
}

func (w *Writer) readIndex() *uint64 {
	return (*uint64)(unsafe.Pointer(&w.mem[cacheLine]))
}

func (w *Writer) minReadIndex() *uint64 {
	return (*uint64)(unsafe.Pointer(&w.mem[cacheLine*3]))
}

func (w *Writer) droppedFrames() *uint64 {
	return (*uint64)(unsafe.Pointer(&w.mem[cacheLine*4]))
}

func (w *Writer) data() []byte {
	return w.mem[headerSize:]
}

// Write enqueues a single framed payload. Returns false only when the payload
// is malformed: empty, larger than 1 GiB, or larger than the ring capacity
// (which would make eviction impossible). A full ring is handled by evicting
// the oldest unread frames in-place (drop-oldest) so live writes never block.
func (w *Writer) Write(payload []byte) bool {
	if len(payload) == 0 || len(payload) > 1<<30 {
		return false
	}
	msgSize := uint64(4 + len(payload))
	cap := w.capacity
	if msgSize > cap {
		return false
	}

	writePos := atomic.LoadUint64(w.writeIndex())
	readPos := atomic.LoadUint64(w.readIndex())
	minRead := atomic.LoadUint64(w.minReadIndex())

	consumed := readPos
	if minRead > consumed {
		consumed = minRead
	}

	if writePos-consumed+msgSize > cap {
		newMin := consumed
		evicted := uint64(0)
		data := w.data()
		for writePos-newMin+msgSize > cap {
			frameLen := uint64(readLengthAt(data, newMin, cap))
			newMin += 4 + frameLen
			evicted++
			if newMin > writePos {
				// Header corruption guard: a length prefix walked past the
				// writer's own cursor. Drop the message rather than scribble.
				return false
			}
		}

		// Publish dropped_frames before min_read_pos so a reader that observes
		// the new floor with Acquire ordering also sees the matching gap delta.
		atomic.AddUint64(w.droppedFrames(), evicted)
		atomic.StoreUint64(w.minReadIndex(), newMin)
	}

	data := w.data()
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(payload)))
	w.writeWrapped(data, writePos, cap, lenBuf[:])
	w.writeWrapped(data, writePos+4, cap, payload)

	atomic.StoreUint64(w.writeIndex(), writePos+msgSize)

	return true
}

func readLengthAt(data []byte, pos, cap uint64) uint32 {
	offset := pos % cap
	firstChunk := cap - offset

	if firstChunk >= 4 {
		return binary.BigEndian.Uint32(data[offset : offset+4])
	}
	var buf [4]byte
	copy(buf[:firstChunk], data[offset:])
	copy(buf[firstChunk:], data[:4-firstChunk])
	return binary.BigEndian.Uint32(buf[:])
}

func (w *Writer) writeWrapped(data []byte, pos, cap uint64, src []byte) {
	offset := pos % cap
	firstChunk := cap - offset

	if firstChunk >= uint64(len(src)) {
		copy(data[offset:], src)
	} else {
		copy(data[offset:], src[:firstChunk])
		copy(data[:], src[firstChunk:])
	}
}
