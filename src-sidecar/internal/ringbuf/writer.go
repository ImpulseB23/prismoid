package ringbuf

import (
	"encoding/binary"
	"fmt"
	"sync/atomic"
	"unsafe"
)

const (
	cacheLine  = 64
	headerSize = cacheLine * 3
)

// Writer writes length-prefixed messages into a shared memory ring buffer.
// The buffer layout matches the Rust reader:
//   - [0..64)    write_index (uint64, cache-line aligned)
//   - [64..128)  read_index (uint64, cache-line aligned)
//   - [128..192) capacity   (uint64, cache-line aligned)
//   - [192..)    data region (circular buffer)
type Writer struct {
	mem      []byte
	capacity uint64
}

// Open attaches to an existing shared memory region by raw byte slice.
// The caller is responsible for mapping the shared memory and passing the full slice.
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

func (w *Writer) data() []byte {
	return w.mem[headerSize:]
}

// Write writes a length-prefixed message to the ring buffer.
// Returns false if the buffer is full (message would overwrite unread data).
func (w *Writer) Write(payload []byte) bool {
	msgSize := uint64(4 + len(payload))
	cap := w.capacity

	writePos := atomic.LoadUint64(w.writeIndex())
	readPos := atomic.LoadUint64(w.readIndex())

	// check if there's enough space
	if writePos-readPos+msgSize > cap {
		return false
	}

	data := w.data()

	// write length (4 bytes, big-endian)
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(payload)))
	w.writeWrapped(data, writePos, cap, lenBuf[:])

	// write payload
	w.writeWrapped(data, writePos+4, cap, payload)

	// publish with release semantics
	atomic.StoreUint64(w.writeIndex(), writePos+msgSize)

	return true
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
