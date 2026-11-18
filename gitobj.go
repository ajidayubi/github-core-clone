// Low-level git objects: SHA-1 ids, tree/commit/tag codecs, pkt-line framing,
// packfile reading and writing, and delta application. No git binary involved.
package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
)

const zeroOID = "0000000000000000000000000000000000000000"

func isOID(s string) bool {
	if len(s) != 40 {
		return false
	}
	for i := 0; i < 40; i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// hashObject returns git's object id: SHA-1 over "<type> <len>\0" + data.
func hashObject(typ string, data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s %d\x00", typ, len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

type treeEntry struct {
	mode string
	name string
	oid  string
}

// parseTree decodes a tree object's entries in stored order.
func parseTree(data []byte) ([]treeEntry, error) {
	var out []treeEntry
	i := 0
	for i < len(data) {
		sp := bytes.IndexByte(data[i:], ' ')
		if sp < 0 {
			return nil, errors.New("tree: no mode separator")
		}
		mode := string(data[i : i+sp])
		j := i + sp + 1
		nul := bytes.IndexByte(data[j:], 0)
		if nul < 0 || j+nul+21 > len(data) {
			return nil, errors.New("tree: truncated entry")
		}
		name := string(data[j : j+nul])
		oid := hex.EncodeToString(data[j+nul+1 : j+nul+21])
		out = append(out, treeEntry{mode: mode, name: name, oid: oid})
		i = j + nul + 21
	}
	return out, nil
}

// treeSortKey is git's ordering: a directory compares as if its name ended in '/'.
func treeSortKey(e treeEntry) string {
	if e.mode == "40000" {
		return e.name + "/"
	}
	return e.name
}

// buildTree encodes entries sorted the way git sorts them.
func buildTree(entries []treeEntry) []byte {
	sorted := make([]treeEntry, len(entries))
	copy(sorted, entries)
	sort.SliceStable(sorted, func(i, j int) bool { return treeSortKey(sorted[i]) < treeSortKey(sorted[j]) })
	var buf bytes.Buffer
	for _, e := range sorted {
		raw, _ := hex.DecodeString(e.oid)
		fmt.Fprintf(&buf, "%s %s\x00", e.mode, e.name)
		buf.Write(raw)
	}
	return buf.Bytes()
}

type commitView struct {
	tree      string
	parents   []string
	author    string
	committer string
	message   string
}

// parseCommit decodes a commit object.
func parseCommit(data []byte) (commitView, error) {
	var c commitView
	blank := bytes.Index(data, []byte("\n\n"))
	head := data
	if blank >= 0 {
		head = data[:blank]
		c.message = string(data[blank+2:])
	}
	for _, line := range bytes.Split(head, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		sp := bytes.IndexByte(line, ' ')
		if sp < 0 {
			continue
		}
		key, val := string(line[:sp]), string(line[sp+1:])
		switch key {
		case "tree":
			c.tree = val
		case "parent":
			c.parents = append(c.parents, val)
		case "author":
			c.author = val
		case "committer":
			c.committer = val
		}
	}
	if !isOID(c.tree) {
		return c, errors.New("commit: bad tree")
	}
	return c, nil
}

// buildCommit renders a commit object. who is "Name <mail> ts +0000".
func buildCommit(tree string, parents []string, who, message string) []byte {
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "tree %s\n", tree)
	for _, p := range parents {
		fmt.Fprintf(&buf, "parent %s\n", p)
	}
	fmt.Fprintf(&buf, "author %s\ncommitter %s\n\n%s", who, who, message)
	return buf.Bytes()
}

type tagView struct {
	object  string
	typ     string
	tag     string
	tagger  string
	message string
}

func parseTag(data []byte) (tagView, error) {
	var t tagView
	blank := bytes.Index(data, []byte("\n\n"))
	head := data
	if blank >= 0 {
		head = data[:blank]
		t.message = string(data[blank+2:])
	}
	for _, line := range bytes.Split(head, []byte("\n")) {
		sp := bytes.IndexByte(line, ' ')
		if sp < 0 {
			continue
		}
		switch string(line[:sp]) {
		case "object":
			t.object = string(line[sp+1:])
		case "type":
			t.typ = string(line[sp+1:])
		case "tag":
			t.tag = string(line[sp+1:])
		case "tagger":
			t.tagger = string(line[sp+1:])
		}
	}
	return t, nil
}

// ---------------------------------------------------------------- pkt-line

func pktLine(payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	copy(out[:4], fmt.Sprintf("%04x", len(payload)+4))
	copy(out[4:], payload)
	return out
}

func pktFlush() []byte { return []byte("0000") }
func pktDelim() []byte { return []byte("0001") }

type pkt struct {
	kind byte // 'd' data, 'f' flush, 'l' delim, 'e' response-end
	data []byte
}

// decodePktLines splits a buffer into pkt-lines; trailing raw bytes are returned
// separately (a receive-pack body is pkt-lines followed by a raw packfile).
func decodePktLines(b []byte) ([]pkt, []byte, error) {
	var out []pkt
	i := 0
	for i+4 <= len(b) {
		h := string(b[i : i+4])
		if len(h) != 4 {
			break
		}
		// A packfile starts with "PACK" or zlib data, not hex digits.
		isHex := true
		for _, c := range h {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				isHex = false
			}
		}
		if !isHex {
			break
		}
		var n int
		_, err := fmt.Sscanf(h, "%04x", &n)
		if err != nil {
			break
		}
		if n == 0 {
			out = append(out, pkt{kind: 'f'})
			i += 4
			continue
		}
		if n == 1 {
			out = append(out, pkt{kind: 'l'})
			i += 4
			continue
		}
		if n == 2 {
			out = append(out, pkt{kind: 'e'})
			i += 4
			continue
		}
		if n < 4 || i+n > len(b) {
			return nil, nil, errors.New("pkt-line: truncated")
		}
		out = append(out, pkt{kind: 'd', data: b[i+4 : i+n]})
		i += n
	}
	return out, b[i:], nil
}

// ---------------------------------------------------------------- packfiles

type packObject struct {
	typ  string
	data []byte
}

// applyDelta applies a git delta stream to a base object's bytes.
func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readVarint := func() (int, error) {
		v, shift := 0, 0
		for {
			if off >= len(delta) {
				return 0, errors.New("delta: truncated varint")
			}
			b := delta[off]
			off++
			v |= int(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
		}
		return v, nil
	}
	srcSize, err := readVarint()
	if err != nil {
		return nil, err
	}
	tgtSize, err := readVarint()
	if err != nil {
		return nil, err
	}
	if srcSize != len(base) {
		return nil, errors.New("delta: base size mismatch")
	}
	out := make([]byte, 0, tgtSize)
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			copyOff, copySize := 0, 0
			for bit := 0; bit < 4; bit++ {
				if op&(1<<bit) != 0 {
					if off >= len(delta) {
						return nil, errors.New("delta: truncated copy")
					}
					copyOff |= int(delta[off]) << (bit * 8)
					off++
				}
			}
			for bit := 0; bit < 3; bit++ {
				if op&(0x10<<bit) != 0 {
					if off >= len(delta) {
						return nil, errors.New("delta: truncated copy")
					}
					copySize |= int(delta[off]) << (bit * 8)
					off++
				}
			}
			if copySize == 0 {
				copySize = 0x10000
			}
			if copyOff+copySize > len(base) {
				return nil, errors.New("delta: copy out of range")
			}
			out = append(out, base[copyOff:copyOff+copySize]...)
		} else if op != 0 {
			n := int(op & 0x7f)
			if off+n > len(delta) {
				return nil, errors.New("delta: truncated insert")
			}
			out = append(out, delta[off:off+n]...)
			off += n
		} else {
			return nil, errors.New("delta: opcode 0")
		}
	}
	if len(out) != tgtSize {
		return nil, errors.New("delta: target size mismatch")
	}
	return out, nil
}

var typeCode = map[string]int{"commit": 1, "tree": 2, "blob": 3, "tag": 4}
var codeType = map[int]string{1: "commit", 2: "tree", 3: "blob", 4: "tag"}

// readPack parses a packfile, resolving OFS_DELTA and REF_DELTA entries.
// resolveBase supplies objects a thin pack leaves out.
func readPack(pack []byte, resolveBase func(oid string) *packObject) (map[string]*packObject, error) {
	if len(pack) < 32 || string(pack[:4]) != "PACK" {
		return nil, errors.New("pack: bad header")
	}
	ver := binary.BigEndian.Uint32(pack[4:8])
	if ver != 2 && ver != 3 {
		return nil, errors.New("pack: bad version")
	}
	count := int(binary.BigEndian.Uint32(pack[8:12]))
	trailerStart := len(pack) - 20
	type raw struct {
		off      int
		code     int
		size     int
		data     []byte
		baseOff  int
		baseOID  string
		resolved *packObject
		oid      string
	}
	raws := make([]*raw, 0, count)
	byOff := make(map[int]*raw)
	off := 12
	for i := 0; i < count; i++ {
		start := off
		if off >= trailerStart {
			return nil, errors.New("pack: truncated")
		}
		b := pack[off]
		code := int((b >> 4) & 7)
		size := int(b & 0x0f)
		shift := 4
		off++
		for b&0x80 != 0 {
			if off >= trailerStart {
				return nil, errors.New("pack: truncated size")
			}
			b = pack[off]
			off++
			size |= int(b&0x7f) << shift
			shift += 7
		}
		r := &raw{off: start, code: code, size: size}
		if code == 6 {
			// OFS_DELTA: negative offset varint.
			if off >= trailerStart {
				return nil, errors.New("pack: truncated ofs")
			}
			b = pack[off]
			off++
			v := int(b & 0x7f)
			for b&0x80 != 0 {
				if off >= trailerStart {
					return nil, errors.New("pack: truncated ofs")
				}
				b = pack[off]
				off++
				v = ((v + 1) << 7) | int(b&0x7f)
			}
			r.baseOff = start - v
		} else if code == 7 {
			if off+20 > trailerStart {
				return nil, errors.New("pack: truncated ref")
			}
			r.baseOID = hex.EncodeToString(pack[off : off+20])
			off += 20
		} else if codeType[code] == "" {
			return nil, fmt.Errorf("pack: bad type %d", code)
		}
		// Inflate one zlib stream starting at off. flate reads a *bytes.Reader
		// byte-by-byte (it implements io.ByteReader), so after the stream ends
		// the reader's remaining length tells us exactly how many bytes the
		// zlib stream consumed.
		br := bytes.NewReader(pack[off:trailerStart])
		zr, err := zlib.NewReader(br)
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(zr)
		zr.Close()
		if err != nil {
			return nil, err
		}
		if len(data) != size {
			return nil, errors.New("pack: size mismatch")
		}
		r.data = data
		off += (trailerStart - off) - br.Len()
		raws = append(raws, r)
		byOff[start] = r
	}
	_ = off
	objects := make(map[string]*packObject, count)
	byOID := make(map[string]*raw)
	var resolve func(r *raw) (*packObject, error)
	resolving := make(map[int]bool)
	resolve = func(r *raw) (*packObject, error) {
		if r.resolved != nil {
			return r.resolved, nil
		}
		if resolving[r.off] {
			return nil, errors.New("pack: delta cycle")
		}
		resolving[r.off] = true
		defer delete(resolving, r.off)
		var typ string
		var data []byte
		switch r.code {
		case 6:
			base, ok := byOff[r.baseOff]
			if !ok {
				return nil, errors.New("pack: ofs base missing")
			}
			b, err := resolve(base)
			if err != nil {
				return nil, err
			}
			typ = b.typ
			data, err = applyDelta(b.data, r.data)
			if err != nil {
				return nil, err
			}
		case 7:
			if br, ok := byOID[r.baseOID]; ok {
				b, err := resolve(br)
				if err != nil {
					return nil, err
				}
				typ = b.typ
				data, err = applyDelta(b.data, r.data)
				if err != nil {
					return nil, err
				}
			} else if resolveBase != nil {
				ext := resolveBase(r.baseOID)
				if ext == nil {
					return nil, errors.New("pack: ref base missing")
				}
				typ = ext.typ
				var err error
				data, err = applyDelta(ext.data, r.data)
				if err != nil {
					return nil, err
				}
			} else {
				return nil, errors.New("pack: ref base missing")
			}
		default:
			typ = codeType[r.code]
			data = r.data
		}
		oid := hashObject(typ, data)
		r.oid = oid
		r.resolved = &packObject{typ: typ, data: data}
		byOID[oid] = r
		return r.resolved, nil
	}
	for _, r := range raws {
		obj, err := resolve(r)
		if err != nil {
			return nil, err
		}
		if _, ok := objects[r.oid]; !ok {
			objects[r.oid] = obj
		}
	}
	return objects, nil
}

// writePack builds a packfile of plain (undelted) objects.
func writePack(objs []*packObject) []byte {
	var buf bytes.Buffer
	hdr := make([]byte, 12)
	copy(hdr, "PACK")
	binary.BigEndian.PutUint32(hdr[4:8], 2)
	binary.BigEndian.PutUint32(hdr[8:12], uint32(len(objs)))
	buf.Write(hdr)
	for _, o := range objs {
		code := typeCode[o.typ]
		size := len(o.data)
		// varint: low 4 bits in first byte with type, then 7-bit groups.
		var hb []byte
		first := byte(code<<4) | byte(size&0x0f)
		size >>= 4
		if size > 0 {
			hb = append(hb, first|0x80)
			for size > 0 {
				b := byte(size & 0x7f)
				size >>= 7
				if size > 0 {
					b |= 0x80
				}
				hb = append(hb, b)
			}
		} else {
			hb = append(hb, first)
		}
		buf.Write(hb)
		zw, _ := zlib.NewWriterLevel(&buf, zlib.BestSpeed)
		zw.Write(o.data)
		zw.Close()
	}
	body := buf.Bytes()
	sum := sha1.Sum(body)
	out := make([]byte, 0, len(body)+20)
	out = append(out, body...)
	out = append(out, sum[:]...)
	return out
}

// packTrailerOk checks a packfile's SHA-1 trailer.
func packTrailerOk(pack []byte) bool {
	if len(pack) < 20 {
		return false
	}
	sum := sha1.Sum(pack[:len(pack)-20])
	return bytes.Equal(sum[:], pack[len(pack)-20:])
}
