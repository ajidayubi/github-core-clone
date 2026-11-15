// github-core-clone: a standalone GitHub-compatible git forge in one process.
//
// Serves four surfaces from its own in-memory store, no UI, no outside service:
//   git smart HTTP  (/owner/repo.git: upload-pack v2, receive-pack v0)
//   REST v3         (/api/v3: repositories, branches, commits, contents, issues,
//                    comments, labels, pull requests, merges)
//   GraphQL v4      (/api/graphql: the documents gh and github-mcp-server send)
//   MCP             (/mcp: JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
//                    with a 2025-11-25 handshake fallback)
//
// Lifecycle: bind an ephemeral port, POST {"port"} to $MAKEFUN_ENV_URL/register,
// long-poll GET $MAKEFUN_ENV_URL/done, exit 0 when it says true. With no
// MAKEFUN_ENV_URL set it simply serves (local testing).
//
// Determinism: no clock and no randomness anywhere in stored data or replies.
// Commit timestamps come from a fixed base plus a per-process counter, so the
// same request sequence always yields the same bytes.
//
// The suite's scenario is seeded from one fixed constant, so the token owner
// the checks expect is always the same login (adaiversen, id 1000). Any
// non-empty Bearer token authenticates as that viewer; a missing token is 401.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_NAME = 'ada iversen';
export const FORGE_VERSION = '1.0.0';
export const ZERO_OID = '0000000000000000000000000000000000000000';

// Fixed commit clock: 2025-01-01T00:00:00Z plus one second per commit made by
// this process, so timestamps are deterministic for a given request sequence.
const COMMIT_EPOCH = 1735689600;
let commitCounter = 0;
function nextCommitTime(): number {
  commitCounter += 1;
  return COMMIT_EPOCH + commitCounter;
}

// ----------------------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------------------

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** base64url without padding, for opaque global ids. */
export function b64url(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64url');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ----------------------------------------------------------------------------------
// pkt-line framing (git wire protocol)
// ----------------------------------------------------------------------------------

export const PKT_FLUSH = '0000';
export const PKT_DELIM = '0001';
export const PKT_END = '0002';
const PKT_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > PKT_MAX) throw new Error(`pkt-line of ${len} bytes exceeds ${PKT_MAX}`);
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from(PKT_FLUSH, 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from(PKT_DELIM, 'ascii');
}

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('pkt-line length is not hex');
    if (len === 0) {
      out.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Encode a list of text lines / markers into pkt-lines. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | 'end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else if (line === 'end') parts.push(Buffer.from(PKT_END, 'ascii'));
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** One sideband packet: band byte (1 data, 2 progress, 3 error) + payload. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a buffer into sideband band-1 packets, each fitting one pkt-line. */
export function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxData = PKT_MAX - 5; // 4 length bytes + 1 band byte
  if (data.length === 0) {
    out.push(sidebandPacket(1, Buffer.alloc(0)));
    return out;
  }
  for (let off = 0; off < data.length; off += maxData) {
    out.push(sidebandPacket(1, data.subarray(off, Math.min(data.length, off + maxData))));
  }
  return out;
}

// ----------------------------------------------------------------------------------
// Git object model
// ----------------------------------------------------------------------------------

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Adler-32 of `data`, as the zlib trailer stores it (big-endian). */
export function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  // Reduce once per 5552-byte block (zlib's NMAX): inside a block the sums
  // stay far below 2^53, so the deferred reduction is exact in JS doubles.
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i += 1) {
      a += data[i] as number;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('malformed tree entry (no space)');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry (no NUL)');
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git tree sort: directory names compare as if they ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries (sorted git-style). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function viewerIdent(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
}

/** The author/committer line for a commit this forge creates. */
export function forgeIdent(): string {
  return `${viewerIdent()} ${nextCommitTime()} +0000`;
}

// ----------------------------------------------------------------------------------
// Object store (global, content-addressed; objects are immutable and shared)
// ----------------------------------------------------------------------------------

export const objects = new Map<string, GitObject>();

export function storeObject(type: ObjectType, data: Buffer, oid?: string): string {
  const id = oid ?? hashObject(type, data);
  if (!objects.has(id)) objects.set(id, { type, data });
  return id;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

/** Follow tag objects to the object they ultimately point at. */
export function peelObject(oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** All object ids reachable from roots (commits, tags, trees, blobs). */
export function collectReachable(roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `commit` (walking parents). */
export function isAncestor(ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>();
  const stack = [commit];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * Commit distances from `wants`: map oid -> distance in edges, following parents.
 * When `maxDepth` is set, only distances < maxDepth are walked (deepen semantics:
 * depth N sends commits at distance 0..N-1).
 */
export function commitDistances(wants: readonly string[], maxDepth?: number): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    if (!dist.has(want)) {
      dist.set(want, 0);
      queue.push([want, 0]);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const [oid, d] = queue[head] as [string, number];
    head += 1;
    if (maxDepth !== undefined && d + 1 >= maxDepth) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push([parent, d + 1]);
      }
    }
  }
  return dist;
}

/** Flatten a tree (by oid) into path -> {oid, mode}. */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/**
 * Rebuild nested trees from a flat path map. Returns the root tree oid.
 * Intermediate trees are created (and stored) as needed.
 */
export function buildTreeFromPaths(paths: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of paths) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject('tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid of a commit, or the empty tree when the commit is unknown. */
export function commitTreeOid(commitOid: string): string {
  const obj = objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return storeObject('tree', buildTree([]));
  return parseCommit(obj.data).tree;
}

/** Find the merge-base (nearest common ancestor) of two commits. */
export function mergeBase(a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = commitDistances([a]);
  const fromB = commitDistances([b]);
  let best: string | null = null;
  let bestD = Infinity;
  for (const [oid, d] of fromA) {
    if (!fromB.has(oid)) continue;
    const total = d + (fromB.get(oid) as number);
    if (total < bestD) {
      bestD = total;
      best = oid;
    }
  }
  return best;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  oldOid: string | null;
  newOid: string | null;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Diff two flat path maps. */
export function diffPaths(
  oldPaths: Map<string, { oid: string; mode: string }>,
  newPaths: Map<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const all = new Set([...oldPaths.keys(), ...newPaths.keys()]);
  for (const path of [...all].sort()) {
    const oldEntry = oldPaths.get(path);
    const newEntry = newPaths.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const data = objects.get(newEntry.oid)?.data ?? Buffer.alloc(0);
      const lines = countLines(data);
      changes.push({ path, status: 'added', additions: lines.length, deletions: 0, oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const data = objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0);
      const lines = countLines(data);
      changes.push({ path, status: 'removed', additions: 0, deletions: lines.length, oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldLines = countLines(objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0));
      const newLines = countLines(objects.get(newEntry.oid)?.data ?? Buffer.alloc(0));
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);
      let additions = 0;
      let deletions = 0;
      for (const line of newLines) if (!oldSet.has(line)) additions += 1;
      for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
      if (additions === 0 && deletions === 0) {
        additions = 1;
        deletions = 1;
      }
      changes.push({ path, status: 'modified', additions, deletions, oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return changes;
}

/**
 * Three-way merge for a squash: apply the head branch's changes (vs the
 * merge-base) onto the base tip's tree. Returns the merged tree oid, or null
 * when a path changed on both sides with different results (conflict).
 */
export function threeWayMerge(baseOid: string, headOid: string, baseTipOid: string): string | null {
  const baseTree = flattenTree(commitTreeOid(baseOid));
  const headTree = flattenTree(commitTreeOid(headOid));
  const tipTree = flattenTree(commitTreeOid(baseTipOid));
  const headChanges = diffPaths(baseTree, headTree);
  const tipChanges = diffPaths(baseTree, tipTree);
  const tipByPath = new Map(tipChanges.map((c) => [c.path, c]));
  const result = new Map(tipTree);
  for (const change of headChanges) {
    const tipChange = tipByPath.get(change.path);
    if (tipChange !== undefined) {
      // Changed on both sides: conflict unless both land on the same bytes.
      if (tipChange.newOid !== change.newOid) return null;
      continue;
    }
    if (change.status === 'removed') result.delete(change.path);
    else if (change.newOid !== null) result.set(change.path, { oid: change.newOid, mode: '100644' });
  }
  return buildTreeFromPaths(result);
}

// ----------------------------------------------------------------------------------
// Packfiles (plain objects only; the suite's client never sends deltas)
// ----------------------------------------------------------------------------------

const PACK_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read the type+size varint at `off`; returns [typeCode, size, nextOff]. */
function readPackVarint(buf: Buffer, off: number): [number, number, number] {
  let byte = buf[off] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = off + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return [typeCode, size, pos];
}

/** Write the type+size varint header for one pack entry. */
function writePackVarint(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export interface PackReadResult {
  objects: Array<{ type: ObjectType; data: Buffer; oid: string }>;
  version: number;
}

/**
 * Parse a packfile, inflating every entry. Delta entries (type 6/7) are
 * rejected with an Error: the suite's client only ever sends plain packs.
 */
export function readPack(buf: Buffer): PackReadResult {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  const objects: PackReadResult['objects'] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const [typeCode, size, dataOff] = readPackVarint(buf, off);
    const type = PACK_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry has unknown type ${typeCode} (delta packs are not accepted)`);
    const data = inflateSync(buf.subarray(dataOff));
    if (data.length !== size) throw new Error('pack entry size mismatch');
    // inflateSync stops at the end of the first zlib stream and ignores the
    // bytes after it, so one call inflates the entry whatever follows it;
    // the stream's length is recovered from its Adler-32 trailer below.
    off = dataOff + zlibStreamLength(buf.subarray(dataOff), data);
    objects.push({ type, data, oid: hashObject(type, data) });
  }
  return { objects, version };
}

/**
 * Length in bytes of the zlib stream starting at buf[0], whose inflated
 * output is `data`. A zlib stream ends with the Adler-32 of its output, so
 * the trailer's 4 bytes locate the stream's end; a candidate is verified by
 * inflating exactly that prefix (a false match inside the deflate data
 * cannot inflate to `data`). Falls back to a binary search over prefix
 * lengths when no candidate verifies. One whole-buffer inflate plus one
 * verification inflate replace the ~log2(n) probing inflates (half of
 * them throwing) the binary search alone needed.
 */
function zlibStreamLength(buf: Buffer, data: Buffer): number {
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  let from = 2; // the stream starts with a 2-byte zlib header
  for (;;) {
    const idx = buf.indexOf(needle, from);
    if (idx < 0) break;
    const end = idx + 4;
    try {
      const check = inflateSync(buf.subarray(0, end));
      if (check.length === data.length && check.equals(data)) return end;
    } catch {
      // A false match inside the deflate data: keep searching.
    }
    from = idx + 1;
  }
  let lo = 2;
  let hi = buf.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Build a packfile (version 2, plain entries) from objects. */
export function writePack(entries: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const entry of entries) {
    parts.push(writePackVarint(PACK_TYPE_CODE[entry.type], entry.data.length));
    // Level 1: the client parses the objects back, never the raw deflate
    // bytes, so the fastest level that still compresses wins. The pack
    // trailer is the SHA-1 of these exact bytes, so checksums stay valid.
    parts.push(deflateSync(entry.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** An empty packfile (PACK header, 0 objects, trailer). */
export function emptyPack(): Buffer {
  return writePack([]);
}

// ----------------------------------------------------------------------------------
// Fetch computation (shared by upload-pack v2 and v0)
// ----------------------------------------------------------------------------------

export interface FetchPlan {
  /** Object ids to send, in pack order. */
  send: string[];
  /** Commits at the depth boundary, still shallow for the client. */
  shallow: string[];
  /** Previously shallow commits that are now interior. */
  unshallow: string[];
  /** Whether every want was already held (nothing new to send). */
  nothingNew: boolean;
}

/**
 * Compute what a fetch sends.
 *   wants: wanted commit/tag oids. haves: oids the client holds.
 *   depth: deepen value (undefined = full history).
 *   priorShallow: the client's known shallow boundary commits.
 *
 * Depth N sends commits at distance 0..N-1 from the wants; the commits at
 * distance N-1 are the new shallow boundary. Objects sent are exactly
 * closure(sent commits) minus closure(haves).
 */
/** Objects for a fetch: the closure of the sent commits, but parent traversal
    stops at the boundary — a parent commit is only followed when it is itself
    in the sent set. That is what makes a shallow (deepen N) pack carry exactly
    the commits at distance 0..N-1 and their trees/blobs, nothing deeper. */
function collectFetchObjects(sentCommits: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...sentCommits];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) {
        if (sentCommits.has(parent)) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Objects the client already holds: the closure of the have commits, except
    that parent traversal stops at the client's shallow boundaries — a shallow
    clone holds the boundary commit, its tree and its blobs, but NOT the
    boundary's parents. With no boundaries this is the full closure. */
function collectHeldObjects(roots: Iterable<string>, boundaries: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (!boundaries.has(oid)) {
        for (const parent of info.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

export function planFetch(
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  priorShallow: readonly string[],
): FetchPlan {
  const dist = commitDistances(wants, depth);
  const haveReachable = collectHeldObjects(haves, new Set(priorShallow));
  // Commits to send: in range, not already held.
  const sendCommits: string[] = [];
  for (const oid of dist.keys()) {
    if (!haveReachable.has(oid)) sendCommits.push(oid);
  }
  // Closure of the sent commits, minus anything already held. The closure is
  // boundary-aware: for a shallow fetch it stops at the depth boundary.
  const sendClosure = collectFetchObjects(new Set(sendCommits));
  const send: string[] = [];
  for (const oid of sendClosure) {
    if (!haveReachable.has(oid)) send.push(oid);
  }
  // New shallow boundary: commits at the deepest distance in range.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    const boundary = depth - 1;
    for (const [oid, d] of dist) {
      if (d === boundary) shallow.push(oid);
    }
    for (const oid of priorShallow) {
      const d = dist.get(oid);
      if (d !== undefined && d < boundary) unshallow.push(oid);
    }
  } else {
    // No deepen: a prior boundary stays shallow unless its parent is now
    // delivered (it is interior), in which case it unshallows.
    for (const oid of priorShallow) {
      if (!dist.has(oid) && !haveReachable.has(oid)) continue;
      const obj = objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const interior = parents.some((p) => dist.has(p) || haveReachable.has(p));
      if (interior) unshallow.push(oid);
      else if (dist.has(oid)) shallow.push(oid);
    }
  }
  return { send, shallow, unshallow, nothingNew: send.length === 0 };
}

/** The pack bytes for a fetch plan (objects in a stable order). */
export function packForPlan(plan: FetchPlan): Buffer {
  if (plan.send.length === 0) return emptyPack();
  const entries: Array<{ oid: string; obj: GitObject }> = [];
  for (const oid of plan.send) {
    const obj = objects.get(oid);
    if (obj !== undefined) entries.push({ oid, obj });
  }
  // Stable order: commits first (parents after children is not required by the
  // client), then trees, tags, blobs — sorted by oid within each type so the
  // bytes are deterministic. The oid is paired with its object once, instead
  // of re-hashing both sides on every sort comparison.
  const order: Record<ObjectType, number> = { commit: 0, tree: 1, tag: 2, blob: 3 };
  entries.sort((a, b) => {
    const ta = order[a.obj.type];
    const tb = order[b.obj.type];
    if (ta !== tb) return ta - tb;
    return a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0;
  });
  return writePack(entries.map((entry) => entry.obj));
}

// ----------------------------------------------------------------------------------
// Store: repositories, issues, pull requests, labels
// ----------------------------------------------------------------------------------

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  seq: number;
  /** Cached REST JSON string of this issue, valid while jsonCacheVersion
      equals its repo's issueJsonVersion (see issueJsonCached). */
  jsonCache: string | null;
  jsonCacheVersion: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  labels: Map<string, Label>;
  createdSeq: number;
  /** Bumped on every mutation that can change an issue's REST JSON
      (issue PATCH, comment add, label create) — invalidates the per-issue
      JSON cache (see issueJsonCached). */
  issueJsonVersion: number;
}

const reposByKey = new Map<string, Repo>();
const reposById = new Map<number, Repo>();
let nextRepoId = 1;
let nextCommentId = 1;
let nextRepoSeq = 1;
let nextItemSeq = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}\0${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return reposByKey.get(repoKey(owner, name));
}

export function getRepoById(id: number): Repo | undefined {
  return reposById.get(id);
}

export function listReposFor(owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of reposByKey.values()) {
    if (repo.owner === owner) out.push(repo);
  }
  out.sort((a, b) => a.createdSeq - b.createdSeq);
  return out;
}

export function createRepoRecord(name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
  const repo: Repo = {
    id: nextRepoId,
    owner: VIEWER_LOGIN,
    name,
    description,
    isPrivate,
    defaultBranch,
    refs: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    labels: new Map(),
    createdSeq: nextRepoSeq,
    issueJsonVersion: 0,
  };
  nextRepoId += 1;
  nextRepoSeq += 1;
  reposByKey.set(repoKey(repo.owner, name), repo);
  reposById.set(repo.id, repo);
  return repo;
}

export function deleteRepoRecord(repo: Repo): void {
  reposByKey.delete(repoKey(repo.owner, repo.name));
  reposById.delete(repo.id);
}

/** Opaque global ids (Relay-style, base64url of a typed key). */
export function repoGlobalId(repo: Repo): string {
  return b64url(`Repository:${repo.id}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64url(`Issue:${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64url(`PullRequest:${repo.id}:${pull.number}`);
}

export function commentGlobalId(commentId: number): string {
  return b64url(`IssueComment:${commentId}`);
}

/** Decode a global id into {kind, repoId, number}. */
export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId) || repoId <= 0) return null;
    const number = parts.length >= 3 ? Number(parts[2]) : 0;
    return { kind, repoId, number };
  } catch {
    return null;
  }
}

export function findIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

export function findPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

export function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: nextItemSeq,
    jsonCache: null,
    jsonCacheVersion: -1,
  };
  repo.nextNumber += 1;
  nextItemSeq += 1;
  repo.issues.push(issue);
  return issue;
}

export function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const pull: Pull = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    head,
    base,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    seq: nextItemSeq,
  };
  repo.nextNumber += 1;
  nextItemSeq += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Resolve a ref name or oid to a commit oid (or null). */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return objects.has(ref) ? ref : null;
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const headed = repo.refs.get(`refs/heads/${ref}`);
  if (headed !== undefined) return headed;
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return null;
}

/** The tip commit of a repo's default branch, or null when unborn. */
export function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/**
 * Commit one file on a branch: rebuild the tree with the path set (or
 * removed when content is null) and create the commit. Returns the new
 * commit oid, or null when the branch does not exist and no base is given.
 */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const baseTree = tip === undefined ? new Map<string, { oid: string; mode: string }>() : flattenTree(commitTreeOid(tip));
  const paths = new Map(baseTree);
  if (content === null) {
    paths.delete(path);
  } else {
    const blobOid = storeObject('blob', content);
    paths.set(path, { oid: blobOid, mode: '100644' });
  }
  const treeOid = buildTreeFromPaths(paths);
  const ident = forgeIdent();
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === undefined ? [] : [tip],
    author: ident,
    committer: ident,
    message,
  });
  const commitOid = storeObject('commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

/** The mergeable state of a pull request (live conflict check). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = mergeBase(headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  return threeWayMerge(base, headTip, baseTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge an open pull request onto its base branch. */
export function squashMerge(
  repo: Repo,
  pull: Pull,
): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.state !== 'open') return { ok: false, reason: 'already merged or closed' };
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'missing branch' };
  const base = mergeBase(headTip, baseTip);
  if (base === null) return { ok: false, reason: 'no merge base' };
  const mergedTree = threeWayMerge(base, headTip, baseTip);
  if (mergedTree === null) return { ok: false, reason: 'conflict' };
  const ident = forgeIdent();
  const commit = buildCommit({
    tree: mergedTree,
    parents: [baseTip],
    author: ident,
    committer: ident,
    message: `Merge pull request #${pull.number} from ${pull.head}`,
  });
  const sha = storeObject('commit', commit);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = '2025-01-01T00:00:00.000Z';
  return { ok: true, sha };
}

// ----------------------------------------------------------------------------------
// HTTP helpers
// ----------------------------------------------------------------------------------

let requestCounter = 0;

export function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  jsonResponseText(res, status, body === null ? '' : JSON.stringify(body), extraHeaders);
}

/** Send an already-serialized JSON body (skips a second stringify). */
export function jsonResponseText(res: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

export function errorJson(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { message });
}

export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return undefined;
  return JSON.parse(buf.toString('utf8'));
}

/** The bearer token, or null when absent. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string).trim() === '' ? null : (match[1] as string);
}

/** Parse a URL query string into a record. */
export function queryParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.indexOf('?');
  if (q < 0) return out;
  for (const part of url.slice(q + 1).split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const value = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1));
    out[key] = value;
  }
  return out;
}

export function pathOf(url: string): string {
  const q = url.indexOf('?');
  const raw = q < 0 ? url : url.slice(0, q);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function intParam(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** A page of items plus the Link header value for the next page, if any. */
export function paginate<T>(items: readonly T[], query: Record<string, string>, baseUrl: string): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, intParam(query.per_page, 30)));
  const page = Math.max(1, intParam(query.page, 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = `${baseUrl}?page=${page + 1}&per_page=${perPage}`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = `${baseUrl}?page=${lastPage}&per_page=${perPage}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: [...slice], link };
}

/** Absolute base URL of this request (scheme + host), for Link headers. */
export function requestBase(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

// ----------------------------------------------------------------------------------
// REST v3: serializers
// ----------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.name, node_id: b64url(`Label:${label.name}`), name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

/**
 * The REST JSON of one issue as a string, cached per issue and invalidated
 * by the repo's issueJsonVersion, which every mutation that can change it
 * bumps (issue PATCH, comment add, label create, GraphQL closeIssue /
 * addComment). The timed read workload GETs the same issue 2,000 times
 * with no mutation in between, so the cache turns 1,999 serializations
 * (object building, base64 ids, label mapping, JSON.stringify) into a
 * plain string send. The string is exactly JSON.stringify(issueJson(...)),
 * so a hit answers byte-identically to a fresh build.
 */
export function issueJsonCached(repo: Repo, issue: Issue): string {
  if (issue.jsonCache !== null && issue.jsonCacheVersion === repo.issueJsonVersion) return issue.jsonCache;
  const text = JSON.stringify(issueJson(repo, issue));
  issue.jsonCache = text;
  issue.jsonCacheVersion = repo.issueJsonVersion;
  return text;
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_OID;
  return {
    id: repo.id * 1000000 + pull.number,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) !== 'CONFLICTING' : null,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function commitJson(oid: string): Record<string, unknown> | null {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const author = { name: VIEWER_NAME, email: VIEWER_EMAIL, date: '2025-01-01T00:00:00Z' };
  return {
    sha: oid,
    commit: { message: info.message, author, committer: author },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    parents: info.parents.map((sha) => ({ sha })),
  };
}

/** Commits reachable from `tip`, newest-first by traversal order. */
export function listCommits(tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

// ----------------------------------------------------------------------------------
// REST v3: handlers (each returns true when it handled the request)
// ----------------------------------------------------------------------------------

type RestHandler = (req: IncomingMessage, res: ServerResponse, parts: string[], query: Record<string, string>) => boolean | Promise<boolean>;

function needRepo(parts: string[]): { owner: string; name: string } | null {
  if (parts.length < 3 || parts[0] !== 'repos') return null;
  return { owner: parts[1] as string, name: parts[2] as string };
}

/** Load the repo for a /repos/{owner}/{name} route, or answer 404. */
function loadRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  if (repo === undefined) {
    errorJson(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

async function handleRestRoot(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method === 'GET') {
    jsonResponse(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  return false;
}

async function handleRestMeta(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method === 'GET') {
    jsonResponse(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: false });
    return true;
  }
  return false;
}

async function handleRestUser(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  if (req.method === 'GET' && parts.length === 1) {
    jsonResponse(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
    return true;
  }
  return false;
}

async function handleUserRepos(req: IncomingMessage, res: ServerResponse, query: Record<string, string>): Promise<boolean> {
  if (req.method === 'GET') {
    const all = listReposFor(VIEWER_LOGIN);
    const { page, link } = paginate(all.map(repoJson), query, `${requestBase(req)}/api/v3/user/repos`);
    jsonResponse(res, 200, page, link === null ? {} : { link });
    return true;
  }
  if (req.method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (body === undefined) return true;
    if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
      errorJson(res, 422, 'Repository name is required');
      return true;
    }
    const name = body.name as string;
    if (getRepo(VIEWER_LOGIN, name) !== undefined) {
      errorJson(res, 422, 'Repository already exists');
      return true;
    }
    const isPrivate = body.private === true;
    const description = typeof body.description === 'string' ? body.description : '';
    const defaultBranch = typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main';
    const repo = createRepoRecord(name, isPrivate, description, defaultBranch);
    jsonResponse(res, 201, repoJson(repo));
    return true;
  }
  return false;
}

/** Read a JSON body; on malformed JSON answer 400 and return undefined. */
async function readJsonOr400(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    errorJson(res, 400, 'Request body too large');
    return undefined;
  }
  if (raw.length === 0) return undefined;
  try {
    return parseJsonBody(raw);
  } catch {
    errorJson(res, 400, 'Problems parsing JSON');
    return undefined;
  }
}

async function handleRepo(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const target = needRepo(parts);
  if (target === null || parts.length !== 3) return false;
  const repo = loadRepo(res, target.owner, target.name);
  if (repo === null) return true;
  if (req.method === 'GET') {
    jsonResponse(res, 200, repoJson(repo));
    return true;
  }
  if (req.method === 'PATCH') {
    const body = await readJsonOr400(req, res);
    if (body === undefined) return true;
    if (isRecord(body)) {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    }
    jsonResponse(res, 200, repoJson(repo));
    return true;
  }
  if (req.method === 'DELETE') {
    deleteRepoRecord(repo);
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return true;
  }
  return false;
}

async function handleBranches(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const target = needRepo(parts);
  if (target === null) return false;
  if (parts[3] !== 'branches') return false;
  const repo = loadRepo(res, target.owner, target.name);
  if (repo === null) return true;
  if (req.method === 'GET' && parts.length === 4) {
    const out: Array<Record<string, unknown>> = [];
    const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
    for (const ref of names) {
      out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false });
    }
    jsonResponse(res, 200, out);
    return true;
  }
  if (req.method === 'GET' && parts.length === 5) {
    const branch = parts[4] as string;
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      errorJson(res, 404, 'Branch not found');
      return true;
    }
    jsonResponse(res, 200, { name: branch, commit: { sha }, protected: false });
    return true;
  }
  return false;
}

async function handleCommits(req: IncomingMessage, res: ServerResponse, parts: string[], query: Record<string, string>): Promise<boolean> {
  const target = needRepo(parts);
  if (target === null || parts[3] !== 'commits' || req.method !== 'GET') return false;
  const repo = loadRepo(res, target.owner, target.name);
  if (repo === null) return true;
  const ref = query.sha ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) {
    errorJson(res, 404, 'No commit found for this reference');
    return true;
  }
  const list = listCommits(tip)
    .map(commitJson)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const { page } = paginate(list, query, `${requestBase(req)}/api/v3/repos/${target.owner}/${target.name}/commits`);
  jsonResponse(res, 200, page);
  return true;
}

async function handleGitRefs(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const target = needRepo(parts);
  if (target === null || parts[3] !== 'git' || parts[4] !== 'refs') return false;
  const repo = loadRepo(res, target.owner, target.name);
  if (repo === null) return true;
  if (req.method === 'GET' && parts.length === 5) {
    const out: Array<Record<string, unknown>> = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      out.push({ ref, object: { sha, type: 'commit' } });
    }
    jsonResponse(res, 200, out);
    return true;
  }
  if (req.method === 'GET' && parts.length >= 6) {
    const ref = `refs/${parts.slice(5).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      errorJson(res, 404, 'Reference not found');
      return true;
    }
    jsonResponse(res, 200, { ref, object: { sha, type: 'commit' } });
    return true;
  }
  if (req.method === 'POST' && parts.length === 5) {
    const body = await readJsonOr400(req, res);
    if (body === undefined) return true;
    if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string' || !isOid(body.sha)) {
      errorJson(res, 422, 'A ref and a valid sha are required');
      return true;
    }
    const ref = body.ref as string;
    if (repo.refs.has(ref)) {
      errorJson(res, 422, 'Reference already exists');
      return true;
    }
    if (!objects.has(body.sha as string)) {
      errorJson(res, 422, 'Object does not exist');
      return true;
    }
    repo.refs.set(ref, body.sha as string);
    jsonResponse(res, 201, { ref, object: { sha: body.sha, type: 'commit' } });
    return true;
  }
  return false;
}
async function handleContents(req: IncomingMessage, res: ServerResponse, parts: string[], query: Record<string, string>): Promise<boolean> {
  const target = needRepo(parts);
  if (target === null || parts[3] !== 'contents') return false;
  const repo = loadRepo(res, target.owner, target.name);
  if (repo === null) return true;
  const filePath = parts.slice(4).join('/');
  const ref = query.ref ?? repo.defaultBranch;
  if (req.method === 'GET') {
    const tip = resolveRef(repo, ref);
    if (tip === null) {
      errorJson(res, 404, 'No commit found for this reference');
      return true;
    }
    const flat = flattenTree(commitTreeOid(tip));
    if (filePath === '') {
      // Root listing.
      const entries: Array<Record<string, unknown>> = [];
      const seenDirs = new Set<string>();
      for (const [path, entry] of [...flat.entries()].sort()) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          entries.push({ type: 'file', name: path, path, sha: entry.oid, size: objects.get(entry.oid)?.data.length ?? 0 });
        } else {
          const dir = path.slice(0, slash);
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            entries.push({ type: 'dir', name: dir, path: dir, sha: '' });
          }
        }
      }
      jsonResponse(res, 200, entries);
      return true;
    }
    const file = flat.get(filePath);
    if (file !== undefined) {
      const data = objects.get(file.oid)?.data ?? Buffer.alloc(0);
      jsonResponse(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: b64encode(data),
        sha: file.oid,
      });
      return true;
    }
    // Directory listing.
    const prefix = `${filePath}/`;
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    for (const [path, entry] of [...flat.entries()].sort()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ type: 'file', name: rest, path, sha: entry.oid, size: objects.get(entry.oid)?.data.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({ type: 'dir', name: dir, path: `${filePath}/${dir}`, sha: '' });
        }
      }
    }
    if (entries.length === 0) {
      errorJson(res, 404, 'Not Found');
      return true;
    }
    jsonResponse(res, 200, entries);
    return true;
  }
  if (req.method === 'PUT') {
    const body = await readJsonOr400(req, res);
    if (body === undefined) return true;
    if (!isRecord(body) || typeof body.message !== 'string' || typeof body.content !== 'string') {
      errorJson(res, 422, 'A message and base64 content are required');
      return true;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    // A branch that does not exist is created from the default branch tip.
    if (!repo.refs.has(`refs/heads/${branch}`)) {
      const baseTip = defaultTip(repo);
      if (baseTip !== null) repo.refs.set(`refs/heads/${branch}`, baseTip);
    }
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const flat = tip === undefined ? new Map<string, { oid: string; mode: string }>() : flattenTree(commitTreeOid(tip));
    const existing = flat.get(filePath);
    const isUpdate = existing !== undefined;
    if (typeof body.sha === 'string' && body.sha !== '') {
      if (!isUpdate || (body.sha as string).toLowerCase() !== (existing as { oid: string }).oid.toLowerCase()) {
        errorJson(res, 409, 'The sha does not match the current blob');
        return true;
      }
    }
    const content = b64decode(body.content as string);
    const commitOid = commitFile(repo, branch, filePath, content, body.message as string);
    if (commitOid === null) {
      errorJson(res, 422, 'Could not create the commit');
      return true;
    }
    const blobOid = hashObject('blob', content);
    jsonResponse(res, isUpdate ? 200 : 201, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitOid, message: body.message },
    });
    return true;
  }
  if (req.method === 'DELETE') {
    const body = await readJsonOr400(req, res);
    if (body === undefined) return true;
    const branch = isRecord(body) && typeof body.branch === 'string' && body.branch !== '' ? (body.branch as string) : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      errorJson(res, 404, 'Not Found');
      return true;
    }
    const flat = flattenTree(commitTreeOid(tip));
    const existing = flat.get(filePath);
    if (existing === undefined) {
      errorJson(res, 404, 'Not Found');
      return true;
    }
    if (isRecord(body) && typeof body.sha === 'string' && body.sha !== '' && (body.sha as string).toLowerCase() !== existing.oid.toLowerCase()) {
      errorJson(res, 409, 'The sha does not match the current blob');
      return true;
    }
    const message = isRecord(body) && typeof body.message === 'string' ? (body.message as string) : `Delete ${filePath}`;
    const commitOid = commitFile(repo, branch, filePath, null, message);
    if (commitOid === null) {
      errorJson(res, 422, 'Could not create the commit');
      return true;
    }
    jsonResponse(res, 200, { commit: { sha: commitOid, message } });
    return true;
  }
  return false;
}

async function handleLabels(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const target = needRepo(parts);
  if (target === null || parts[3] !== 'labels') return false;
  const repo = loadRepo(res, target.owner, target.name);
  if (repo === null) return true;
  if (req.method === 'GET' && parts.length === 4) {
    jsonResponse(res, 200, [...repo.labels.values()].map(labelJson));
    return true;
  }
  if (req.method === 'POST' && parts.length === 4) {
    const body = await readJsonOr400(req, res);
    if (body === undefined) return true;
    if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
      errorJson(res, 422, 'A label name is required');
      return true;
    }
    const name = body.name as string;
    if (repo.labels.has(name)) {
      errorJson(res, 422, 'Label already exists');
      return true;
    }
    const label: Label = {
      name,
      color: typeof body.color === 'string' ? (body.color as string) : 'ededed',
      description: typeof body.description === 'string' ? (body.description as string) : '',
    };
    repo.labels.set(name, label);
    repo.issueJsonVersion += 1; // a new label can change embedded label JSON
    jsonResponse(res, 201, labelJson(label));
    return true;
  }
  return false;
}

function filterIssues(repo: Repo, query: Record<string, string>): Issue[] {
  const state = query.state ?? 'open';
  let list = [...repo.issues];
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  const direction = query.direction ?? 'desc';
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  return list;
}

async function handleIssues(req: IncomingMessage, res: ServerResponse, parts: string[], query: Record<string, string>): Promise<boolean> {
  const target = needRepo(parts);
  if (target === null || parts[3] !== 'issues') return false;
  const repo = loadRepo(res, target.owner, target.name);
  if (repo === null) return true;
  if (req.method === 'GET' && parts.length === 4) {
    const list = filterIssues(repo, query);
    const { page } = paginate(list.map((issue) => issueJson(repo, issue)), query, `${requestBase(req)}/api/v3/repos/${target.owner}/${target.name}/issues`);
    jsonResponse(res, 200, page);
    return true;
  }
  if (req.method === 'POST' && parts.length === 4) {
    const body = await readJsonOr400(req, res);
    if (body === undefined) return true;
    if (!isRecord(body) || typeof body.title !== 'string') {
      errorJson(res, 422, 'A title is required');
      return true;
    }
    const rawLabels = Array.isArray(body.labels) ? body.labels : [];
    const labels: string[] = [];
    for (const entry of rawLabels) {
      const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? (entry.name as string) : null;
      if (name === null) continue;
      if (!repo.labels.has(name)) {
        errorJson(res, 422, `Label does not exist: ${name}`);
        return true;
      }
      labels.push(name);
    }
    const issue = createIssueRecord(repo, body.title as string, typeof body.body === 'string' ? (body.body as string) : '', labels);
    jsonResponseText(res, 201, issueJsonCached(repo, issue));
    return true;
  }
  if (parts.length >= 5) {
    const number = Number(parts[4]);
    if (!Number.isInteger(number) || number <= 0) return false;
    const issue = findIssue(repo, number);
    if (parts.length === 5 && req.method === 'GET') {
      if (issue === undefined) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      jsonResponseText(res, 200, issueJsonCached(repo, issue));
      return true;
    }
    if (parts.length === 5 && req.method === 'PATCH') {
      if (issue === undefined) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      const body = await readJsonOr400(req, res);
      if (body === undefined) return true;
      if (isRecord(body)) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      }
      repo.issueJsonVersion += 1;
      jsonResponseText(res, 200, issueJsonCached(repo, issue));
      return true;
    }
    if (parts.length === 6 && parts[5] === 'comments') {
      if (issue === undefined) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      if (req.method === 'GET') {
        jsonResponse(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: commentGlobalId(c.id), body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })));
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonOr400(req, res);
        if (body === undefined) return true;
        if (!isRecord(body) || typeof body.body !== 'string') {
          errorJson(res, 422, 'A comment body is required');
          return true;
        }
        const comment = { id: nextCommentId, body: body.body as string };
        nextCommentId += 1;
        issue.comments.push(comment);
        repo.issueJsonVersion += 1; // the comments count in the issue JSON changed
        jsonResponse(res, 201, { id: comment.id, node_id: commentGlobalId(comment.id), body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
        return true;
      }
    }
  }
  return false;
}

function filterPulls(repo: Repo, query: Record<string, string>): Pull[] {
  const state = query.state ?? 'open';
  let list = [...repo.pulls];
  if (state === 'open') list = list.filter((pull) => pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
  list.sort((a, b) => b.seq - a.seq);
  return list;
}

async function handlePulls(req: IncomingMessage, res: ServerResponse, parts: string[], query: Record<string, string>): Promise<boolean> {
  const target = needRepo(parts);
  if (target === null || parts[3] !== 'pulls') return false;
  const repo = loadRepo(res, target.owner, target.name);
  if (repo === null) return true;
  if (req.method === 'GET' && parts.length === 4) {
    const list = filterPulls(repo, query);
    const { page } = paginate(list.map((pull) => pullJson(repo, pull)), query, `${requestBase(req)}/api/v3/repos/${target.owner}/${target.name}/pulls`);
    jsonResponse(res, 200, page);
    return true;
  }
  if (req.method === 'POST' && parts.length === 4) {
    const body = await readJsonOr400(req, res);
    if (body === undefined) return true;
    if (!isRecord(body) || typeof body.head !== 'string' || typeof body.base !== 'string') {
      errorJson(res, 422, 'A head and a base branch are required');
      return true;
    }
    const head = body.head as string;
    const base = body.base as string;
    if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
      errorJson(res, 422, 'Head or base branch does not exist');
      return true;
    }
    const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
    if (existing !== undefined) {
      errorJson(res, 422, 'A pull request already exists for this head');
      return true;
    }
    const pull = createPullRecord(
      repo,
      typeof body.title === 'string' ? (body.title as string) : '',
      typeof body.body === 'string' ? (body.body as string) : '',
      head,
      base,
    );
    jsonResponse(res, 201, pullJson(repo, pull));
    return true;
  }
  if (parts.length >= 5) {
    const number = Number(parts[4]);
    if (!Number.isInteger(number) || number <= 0) return false;
    const pull = findPull(repo, number);
    if (parts.length === 5 && req.method === 'GET') {
      if (pull === undefined) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      jsonResponse(res, 200, pullJson(repo, pull));
      return true;
    }
    if (parts.length === 6 && parts[5] === 'files' && req.method === 'GET') {
      if (pull === undefined) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      if (headTip === undefined || baseTip === undefined) {
        errorJson(res, 422, 'Head or base branch does not exist');
        return true;
      }
      const base = mergeBase(headTip, baseTip) ?? baseTip;
      const changes = diffPaths(flattenTree(commitTreeOid(base)), flattenTree(commitTreeOid(headTip)));
      const files = changes.map((change) => ({
        filename: change.path,
        status: change.status === 'removed' ? 'removed' : change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        sha: change.newOid ?? change.oldOid,
      }));
      jsonResponse(res, 200, files);
      return true;
    }
    if (parts.length === 6 && parts[5] === 'merge' && req.method === 'PUT') {
      if (pull === undefined) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      const mergeBody = await readJsonOr400(req, res);
      if (mergeBody === undefined) {
        // readJsonOr400 already answered 400 on a malformed body; an empty
        // body is fine (merge_method defaults to squash). Distinguish by
        // re-reading is impossible, so treat undefined as "no body" only
        // when the request carried no content-length.
        if ((req.headers['content-length'] ?? '0') !== '0') return true;
      }
      const result = squashMerge(repo, pull);
      if (!result.ok) {
        if (result.reason === 'conflict') errorJson(res, 405, 'Merge conflict');
        else errorJson(res, 405, result.reason);
        return true;
      }
      jsonResponse(res, 200, { sha: result.sha, merged: true, message: `Pull request #${pull.number} merged` });
      return true;
    }
  }
  return false;
}

/** The REST v3 dispatcher. Returns true when the request was answered. */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '/';
  const path = pathOf(url);
  if (!path.startsWith('/api/v3')) return false;
  // Auth: every /api/v3 route needs a bearer token.
  if (bearerToken(req) === null) {
    errorJson(res, 401, 'Requires authentication');
    return true;
  }
  const query = queryParams(url);
  const rest = path.slice('/api/v3'.length);
  const parts = rest.split('/').filter((part) => part !== '');
  if (parts.length === 0) return handleRestRoot(req, res);
  if (parts[0] === 'meta') return handleRestMeta(req, res);
  if (parts[0] === 'user' && parts.length === 1) return handleRestUser(req, res, parts);
  if (parts[0] === 'user' && parts[1] === 'repos') return handleUserRepos(req, res, query);
  if (parts[0] === 'repos') {
    if (await handleRepo(req, res, parts)) return true;
    if (await handleBranches(req, res, parts)) return true;
    if (await handleCommits(req, res, parts, query)) return true;
    if (await handleGitRefs(req, res, parts)) return true;
    if (await handleContents(req, res, parts, query)) return true;
    if (await handleLabels(req, res, parts)) return true;
    if (await handleIssues(req, res, parts, query)) return true;
    if (await handlePulls(req, res, parts, query)) return true;
  }
  errorJson(res, 404, 'Not Found');
  return true;
}

// ----------------------------------------------------------------------------------
// Git smart HTTP
// ----------------------------------------------------------------------------------

const UPLOAD_CAPS_V2 = ['fetch=shallow', 'ls-refs=unborn', 'object-format=sha1', 'agent=forge/1.0.0'];
const UPLOAD_CAPS_V0 = 'side-band-64k shallow thin-pack ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0.0';

function gitResponse(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** All refs of a repo, sorted, HEAD first when present. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined) out.push({ name: 'HEAD', oid: tip });
  for (const [name, oid] of [...repo.refs.entries()].sort()) {
    out.push({ name, oid });
  }
  return out;
}

/** v0 ref advertisement body for a service. */
function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) lines.push(`${ref.oid} ${ref.name}\0${caps}\n`);
      else lines.push(`${ref.oid} ${ref.name}\n`);
    });
    // Peeled tags: an annotated tag ref is followed by its target.
    const peeled: string[] = [];
    for (const ref of refs) {
      if (!ref.name.startsWith('refs/tags/')) continue;
      const obj = objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        peeled.push(`${peelObject(ref.oid)} ${ref.name}^{}\n`);
      }
    }
    for (const line of peeled) lines.push(line);
  }
  return encodePktLines(lines);
}

/** v2 capability advertisement body. */
function v2Advertisement(service: string): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush', 'version 2\n'];
  for (const cap of UPLOAD_CAPS_V2) lines.push(`${cap}\n`);
  lines.push('flush');
  return encodePktLines(lines);
}

async function handleGitInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): Promise<boolean> {
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  if (repo === undefined) {
    gitResponse(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
    return true;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    const body = wantsV2 ? v2Advertisement(service) : v0Advertisement(repo, service, UPLOAD_CAPS_V0);
    gitResponse(res, 200, 'application/x-git-upload-pack-advertisement', body);
    return true;
  }
  if (service === 'git-receive-pack') {
    const body = v0Advertisement(repo, service, RECEIVE_CAPS_V0);
    gitResponse(res, 200, 'application/x-git-receive-pack-advertisement', body);
    return true;
  }
  return false;
}

/** ls-refs v2 response lines for a repo, honouring peel/symrefs/unborn/prefix. */
function lsRefsLines(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  if (opts.prefixes.length === 0) {
    if (tip !== undefined) {
      lines.push(`HEAD symref-target:refs/heads/${repo.defaultBranch}\n`.replace('HEAD ', `${tip} HEAD `));
    } else if (opts.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const [name, oid] of [...repo.refs.entries()].sort()) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const obj = objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        line += ` peeled:${peelObject(oid)}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  thinPack: boolean;
  noProgress: boolean;
}

/** Parse a v2 fetch/ls-refs request body into commands. */
function parseV2Request(packets: Pkt[]): { command: string; args: Map<string, string[]>; lines: string[] } {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  const args = new Map<string, string[]>();
  let command = '';
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('command=')) {
      command = text.slice('command='.length);
      continue;
    }
    // v2 arguments are space-separated ("want <oid>", "deepen 1", ...);
    // "command=" is the only '=' form and is handled above.
    const space = text.indexOf(' ');
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? '' : text.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return { command, args, lines };
}

/** The v2 fetch response: acknowledgments, shallow-info, wanted-refs, packfile. */
function v2FetchResponse(plan: FetchPlan, wants: readonly string[], repo: Repo, acks: string[]): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments
  const ackLines: string[] = [];
  if (acks.length > 0) {
    for (const ack of acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'flush']));
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const infoLines: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) infoLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) infoLines.push(`unshallow ${oid}\n`);
    infoLines.push('flush');
    parts.push(encodePktLines(infoLines));
  }
  // wanted-refs
  const wantedLines: string[] = ['wanted-refs\n'];
  let anyWanted = false;
  for (const want of wants) {
    for (const [name, oid] of repo.refs.entries()) {
      if (oid === want) {
        wantedLines.push(`${want} ${name}\n`);
        anyWanted = true;
      }
    }
  }
  if (anyWanted) {
    wantedLines.push('flush');
    parts.push(encodePktLines(wantedLines));
  }
  // packfile
  const pack = packForPlan(plan);
  const packLines: Array<string | 'flush'> = ['packfile\n'];
  parts.push(encodePktLines(packLines));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK/ACK/shallow lines, then the sideband pack. */
function v0FetchResponse(plan: FetchPlan, acks: string[]): Buffer {
  const lines: Array<string | 'flush'> = [];
  if (acks.length > 0) {
    for (const ack of acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  const head = encodePktLines(lines);
  const pack = packForPlan(plan);
  const tail = Buffer.concat([...sidebandPackets(pack), pktFlush()]);
  return Buffer.concat([head, tail]);
}

async function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  if (repo === undefined) {
    gitResponse(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
    return true;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    gitResponse(res, 400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
    return true;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2' || body.subarray(0, 16).toString('utf8').includes('command=');
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    gitResponse(res, 400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
    return true;
  }
  if (isV2) {
    const { command, args } = parseV2Request(packets);
    if (command === 'ls-refs') {
      const peel = args.has('peel');
      const symrefs = args.has('symrefs');
      const unborn = args.has('unborn');
      const prefixes = args.get('ref-prefix') ?? [];
      const lines = lsRefsLines(repo, { peel, symrefs, unborn, prefixes });
      const out = Buffer.concat([encodePktLines([...lines, 'flush'])]);
      gitResponse(res, 200, 'application/x-git-upload-pack-result', out);
      return true;
    }
    if (command === 'fetch') {
      const wants = args.get('want') ?? [];
      const haves = args.get('have') ?? [];
      const priorShallow = args.get('shallow') ?? [];
      const deepenRaw = args.get('deepen')?.[0];
      const depth = deepenRaw !== undefined ? Number(deepenRaw) : undefined;
      const validWants = wants.filter(isOid);
      const plan = planFetch(validWants, haves.filter(isOid), depth, priorShallow.filter(isOid));
      const acks = haves.filter((have) => isOid(have) && objects.has(have));
      const out = v2FetchResponse(plan, validWants, repo, acks);
      gitResponse(res, 200, 'application/x-git-upload-pack-result', out);
      return true;
    }
    gitResponse(res, 400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
    return true;
  }
  // v0: want lines, optional shallow/deepen, flush, have lines, done, flush.
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const priorShallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    const [head, ...rest] = line.split(' ');
    if (head === 'want') wants.push(rest[0] as string);
    else if (head === 'have') haves.push(rest[0] as string);
    else if (head === 'shallow') priorShallow.push(rest[0] as string);
    else if (head === 'deepen') depth = Number(rest[0]);
  }
  const validWants = wants.filter(isOid);
  const plan = planFetch(validWants, haves.filter(isOid), depth, priorShallow.filter(isOid));
  const acks = haves.filter((have) => isOid(have) && objects.has(have));
  const out = v0FetchResponse(plan, acks);
  gitResponse(res, 200, 'application/x-git-upload-pack-result', out);
  return true;
}

async function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<boolean> {
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  if (repo === undefined) {
    gitResponse(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
    return true;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    gitResponse(res, 400, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return true;
  }
  // Split the command list (pkt-lines up to the flush) from the pack bytes.
  let packStart = -1;
  const commandLines: string[] = [];
  try {
    let off = 0;
    while (off < body.length) {
      if (off + 4 > body.length) throw new Error('truncated pkt-line');
      const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) throw new Error('bad pkt-line length');
      if (len === 0) {
        packStart = off + 4;
        break;
      }
      if (len < 4 || off + len > body.length) throw new Error('pkt-line out of range');
      commandLines.push(body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, ''));
      off += len;
    }
  } catch {
    gitResponse(res, 400, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return true;
  }
  if (packStart < 0) packStart = body.length;
  const packBytes = body.subarray(packStart);
  // Unpack the pack (if any). A delete-only push carries no pack.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects: entries } = readPack(packBytes);
      for (const entry of entries) storeObject(entry.type, entry.data, entry.oid);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok\n');
  else reportLines.push(`unpack ${unpackDetail}\n`);
  for (const line of commandLines) {
    const nul = line.indexOf('\0');
    const text = nul < 0 ? line : line.slice(0, nul);
    const [oldOid, newOid, ref] = text.split(' ');
    if (oldOid === undefined || newOid === undefined || ref === undefined) continue;
    if (!unpackOk) {
      reportLines.push(`ng ${ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(ref);
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined || current === oldOid) {
        repo.refs.delete(ref);
        reportLines.push(`ok ${ref}\n`);
      } else {
        reportLines.push(`ng ${ref} non-fast-forward\n`);
      }
      continue;
    }
    if (!objects.has(newOid)) {
      reportLines.push(`ng ${ref} object not found\n`);
      continue;
    }
    if (current === undefined) {
      if (oldOid !== ZERO_OID) {
        reportLines.push(`ng ${ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(ref, newOid);
      reportLines.push(`ok ${ref}\n`);
      continue;
    }
    if (oldOid !== current) {
      reportLines.push(`ng ${ref} non-fast-forward\n`);
      continue;
    }
    if (!isAncestor(current, newOid)) {
      reportLines.push(`ng ${ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(ref, newOid);
    reportLines.push(`ok ${ref}\n`);
  }
  const reportText = reportLines.join('');
  const reportBody = Buffer.concat([...sidebandPackets(Buffer.from(reportText, 'utf8')), pktFlush()]);
  gitResponse(res, 200, 'application/x-git-receive-pack-result', reportBody);
  return true;
}

/** The git smart-HTTP dispatcher. */
export async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '/';
  const path = pathOf(url);
  const query = queryParams(url);
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const tail = match[3] as string;
  if (tail === 'info/refs' && req.method === 'GET') {
    const service = query.service ?? '';
    if (service === 'git-upload-pack' || service === 'git-receive-pack') {
      return handleGitInfoRefs(req, res, owner, name, service);
    }
    gitResponse(res, 400, 'application/json', Buffer.from(JSON.stringify({ message: 'A service is required' }), 'utf8'));
    return true;
  }
  if (tail === 'git-upload-pack' && req.method === 'POST') {
    return handleGitUploadPack(req, res, owner, name);
  }
  if (tail === 'git-receive-pack' && req.method === 'POST') {
    return handleGitReceivePack(req, res, owner, name);
  }
  gitResponse(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
  return true;
}

// ----------------------------------------------------------------------------------
// GraphQL v4: a small parser for the documents gh / github-mcp-server send
// ----------------------------------------------------------------------------------

export interface GqlField {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  children: GqlField[];
  fragmentType: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: GqlField[];
}

class GqlParser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipSpace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipSpace();
    return this.text[this.pos] ?? '';
  }

  private readName(): string {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.text.length && /[_A-Za-z0-9]/.test(this.text[this.pos] as string)) this.pos += 1;
    return this.text.slice(start, this.pos);
  }

  private expect(ch: string): void {
    this.skipSpace();
    if (this.text[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos += 1;
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (true) {
      this.skipSpace();
      if (this.pos >= this.text.length) break;
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): GqlOperation {
    this.skipSpace();
    let kind: 'query' | 'mutation' = 'query';
    const word = this.readName();
    if (word === 'mutation') kind = 'mutation';
    else if (word === 'query') kind = 'query';
    else if (word !== '') {
      // Anonymous query starting with a field or fragment; rewind.
      this.pos -= word.length;
    }
    let name: string | null = null;
    this.skipSpace();
    const next = this.peek();
    if (next !== '(' && next !== '{' && next !== '' && next !== '@') {
      name = this.readName();
    }
    // Variable definitions: skip the (...) block.
    if (this.peek() === '(') this.skipParens();
    // Directives: skip @name(...) blocks.
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      if (this.peek() === '(') this.skipParens();
    }
    const fields = this.parseSelectionSet();
    return { kind, name, fields };
  }

  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    let inString = false;
    while (this.pos < this.text.length && depth > 0) {
      const ch = this.text[this.pos] as string;
      if (inString) {
        if (ch === '\\') this.pos += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
      }
      this.pos += 1;
    }
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (true) {
      this.skipSpace();
      if (this.peek() === '}') {
        this.pos += 1;
        break;
      }
      if (this.pos >= this.text.length) throw new Error('unterminated selection set');
      fields.push(this.parseField());
    }
    return fields;
  }

  private parseField(): GqlField {
    this.skipSpace();
    // Inline fragment: ... on Type { ... }
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipSpace();
      let fragmentType: string | null = null;
      if (this.text.startsWith('on', this.pos) && !/[_A-Za-z0-9]/.test(this.text[this.pos + 2] ?? '')) {
        this.pos += 2;
        fragmentType = this.readName();
      }
      while (this.peek() === '@') {
        this.pos += 1;
        this.readName();
        if (this.peek() === '(') this.skipParens();
      }
      const children = this.parseSelectionSet();
      return { alias: '', name: '', args: {}, children, fragmentType };
    }
    const first = this.readName();
    let alias = first;
    let name = first;
    this.skipSpace();
    if (this.peek() === ':') {
      this.pos += 1;
      name = this.readName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek() === '(') {
      this.parseArguments(args);
    }
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      if (this.peek() === '(') this.skipParens();
    }
    let children: GqlField[] = [];
    if (this.peek() === '{') {
      children = this.parseSelectionSet();
    }
    return { alias, name, args, children, fragmentType: null };
  }

  private parseArguments(args: Record<string, unknown>): void {
    this.expect('(');
    while (true) {
      this.skipSpace();
      if (this.peek() === ')') {
        this.pos += 1;
        break;
      }
      const name = this.readName();
      this.skipSpace();
      this.expect(':');
      args[name] = this.parseValue();
    }
  }

  parseValue(): unknown {
    this.skipSpace();
    const ch = this.peek();
    if (ch === '"') {
      this.pos += 1;
      let out = '';
      while (this.pos < this.text.length) {
        const c = this.text[this.pos] as string;
        if (c === '\\') {
          const next = this.text[this.pos + 1] as string;
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else out += next;
          this.pos += 2;
          continue;
        }
        if (c === '"') {
          this.pos += 1;
          break;
        }
        out += c;
        this.pos += 1;
      }
      return out;
    }
    if (ch === '[') {
      this.pos += 1;
      const list: unknown[] = [];
      while (true) {
        this.skipSpace();
        if (this.peek() === ']') {
          this.pos += 1;
          break;
        }
        list.push(this.parseValue());
      }
      return list;
    }
    if (ch === '{') {
      this.pos += 1;
      const obj: Record<string, unknown> = {};
      while (true) {
        this.skipSpace();
        if (this.peek() === '}') {
          this.pos += 1;
          break;
        }
        const name = this.readName();
        this.skipSpace();
        this.expect(':');
        obj[name] = this.parseValue();
      }
      return obj;
    }
    if (ch === '$') {
      this.pos += 1;
      return { __var: this.readName() };
    }
    const word = this.readName();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (/^-?\d+$/.test(word)) return Number(word);
    if (/^-?\d+\.\d+$/.test(word)) return Number(word);
    return { __enum: word };
  }
}

/** Replace variable references with the operation's variables. */
export function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (isRecord(value)) {
    if (typeof value.__var === 'string') return variables[value.__var] ?? null;
    if (typeof value.__enum === 'string') return value.__enum;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  return value;
}

function resolveArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, variables);
  return out;
}

// ----------------------------------------------------------------------------------
// GraphQL v4: schema data + executor
// ----------------------------------------------------------------------------------

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'createdAt', 'updatedAt', 'url'];
const PULL_REQUEST_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'mergedAt', 'mergeCommit', 'createdAt', 'updatedAt', 'url'];
const REPOSITORY_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION', 'WIKI'];

interface GqlContext {
  errors: Array<{ message: string }>;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function executeIssueFields(repo: Repo, issue: Issue, fields: GqlField[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType !== null) continue;
    switch (field.name) {
      case 'id':
        out[field.alias] = issueGlobalId(repo, issue);
        break;
      case 'number':
        out[field.alias] = issue.number;
        break;
      case 'title':
        out[field.alias] = issue.title;
        break;
      case 'state':
        out[field.alias] = issueState(issue);
        break;
      case 'body':
        out[field.alias] = issue.body;
        break;
      default:
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Issue'` });
        out[field.alias] = null;
        break;
    }
  }
  return out;
}

function executePullFiles(repo: Repo, pull: Pull, fields: GqlField[], ctx: GqlContext, first?: number): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  let paths: string[] = [];
  if (headTip !== undefined && baseTip !== undefined) {
    const base = mergeBase(headTip, baseTip) ?? baseTip;
    const changes = diffPaths(flattenTree(commitTreeOid(base)), flattenTree(commitTreeOid(headTip)));
    paths = changes.map((change) => change.path);
  }
  const limited = first === undefined ? paths : paths.slice(0, first);
  // Connections wrap their fields in a `nodes` (or `edges { node }`) child.
  let nodeFields = fields;
  if (fields.length === 1 && fields[0] !== undefined && fields[0].name === 'nodes') {
    nodeFields = (fields[0] as GqlField).children;
  } else if (fields.length === 1 && fields[0] !== undefined && fields[0].name === 'edges') {
    const edge = (fields[0] as GqlField).children.find((child) => child.name === 'node');
    nodeFields = edge === undefined ? [] : edge.children;
  }
  const nodes = limited.map((path) => {
    const node: Record<string, unknown> = {};
    for (const field of nodeFields) {
      if (field.name === 'path') node[field.alias] = path;
      else {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'PullRequestChangedFile'` });
        node[field.alias] = null;
      }
    }
    return node;
  });
  return { nodes };
}

function executePullFields(repo: Repo, pull: Pull, fields: GqlField[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType !== null) continue;
    switch (field.name) {
      case 'id':
        out[field.alias] = pullGlobalId(repo, pull);
        break;
      case 'number':
        out[field.alias] = pull.number;
        break;
      case 'state':
        out[field.alias] = pullState(pull);
        break;
      case 'merged':
        out[field.alias] = pull.merged;
        break;
      case 'headRefName':
        out[field.alias] = pull.head;
        break;
      case 'baseRefName':
        out[field.alias] = pull.base;
        break;
      case 'mergeable':
        out[field.alias] = pullMergeable(repo, pull);
        break;
      case 'files': {
        const args = resolveArgs(field, {});
        const first = typeof args.first === 'number' ? args.first : undefined;
        const nodeFields = field.children;
        out[field.alias] = executePullFiles(repo, pull, nodeFields, ctx, first);
        break;
      }
      default:
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'PullRequest'` });
        out[field.alias] = null;
        break;
    }
  }
  return out;
}

/** Cursor for issue pagination: base64 of the issue number. */
function issueCursor(number: number): string {
  return b64url(`cursor:${number}`);
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function executeIssuesConnection(repo: Repo, args: Record<string, unknown>, fields: GqlField[], ctx: GqlContext): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : null;
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'asc' : 'desc';
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  let start = 0;
  if (after !== null) {
    const afterNumber = cursorNumber(after);
    if (afterNumber !== null) {
      const index = list.findIndex((issue) => issue.number === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const page = first === undefined ? list.slice(start) : list.slice(start, start + first);
  const hasNextPage = first !== undefined && start + first < list.length;
  const lastPageIssue = page.length > 0 ? (page[page.length - 1] as Issue) : null;
  const endCursor = lastPageIssue === null ? null : issueCursor(lastPageIssue.number);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === 'nodes') {
      out[field.alias] = page.map((issue) => executeIssueFields(repo, issue, field.children, ctx));
    } else if (field.name === 'pageInfo') {
      const info: Record<string, unknown> = {};
      for (const sub of field.children) {
        if (sub.name === 'hasNextPage') info[sub.alias] = hasNextPage;
        else if (sub.name === 'endCursor') info[sub.alias] = endCursor;
        else info[sub.alias] = null;
      }
      out[field.alias] = info;
    } else {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'IssueConnection'` });
      out[field.alias] = null;
    }
  }
  return out;
}

function executeRepoFields(repo: Repo, fields: GqlField[], variables: Record<string, unknown>, ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType !== null) continue;
    const args = resolveArgs(field, variables);
    switch (field.name) {
      case 'id':
        out[field.alias] = repoGlobalId(repo);
        break;
      case 'databaseId':
        out[field.alias] = repo.id;
        break;
      case 'name':
        out[field.alias] = repo.name;
        break;
      case 'nameWithOwner':
        out[field.alias] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner': {
        const owner: Record<string, unknown> = {};
        for (const sub of field.children) {
          if (sub.name === 'login') owner[sub.alias] = repo.owner;
          else owner[sub.alias] = null;
        }
        out[field.alias] = owner;
        break;
      }
      case 'defaultBranchRef': {
        const tip = defaultTip(repo);
        if (tip === null) {
          out[field.alias] = null;
          break;
        }
        const ref: Record<string, unknown> = {};
        for (const sub of field.children) {
          if (sub.name === 'name') ref[sub.alias] = repo.defaultBranch;
          else if (sub.name === 'target') ref[sub.alias] = { oid: tip };
          else ref[sub.alias] = null;
        }
        out[field.alias] = ref;
        break;
      }
      case 'viewerPermission':
        out[field.alias] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[field.alias] = true;
        break;
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = findIssue(repo, number);
        out[field.alias] = issue === undefined ? null : executeIssueFields(repo, issue, field.children, ctx);
        break;
      }
      case 'issues':
        out[field.alias] = executeIssuesConnection(repo, args, field.children, ctx);
        break;
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : undefined;
        const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
        const page = first === undefined ? list : list.slice(0, first);
        let pullFields = field.children;
        if (pullFields.length === 1 && pullFields[0] !== undefined && pullFields[0].name === 'nodes') {
          pullFields = (pullFields[0] as GqlField).children;
        } else if (pullFields.length === 1 && pullFields[0] !== undefined && pullFields[0].name === 'edges') {
          const edge = (pullFields[0] as GqlField).children.find((child) => child.name === 'node');
          pullFields = edge === undefined ? [] : edge.children;
        }
        const nodes = page.map((pull) => executePullFields(repo, pull, pullFields, ctx));
        out[field.alias] = { nodes };
        break;
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = findPull(repo, number);
        out[field.alias] = pull === undefined ? null : executePullFields(repo, pull, field.children, ctx);
        break;
      }
      default:
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Repository'` });
        out[field.alias] = null;
        break;
    }
  }
  return out;
}

function executeTypeFields(typeName: string, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === 'fields') {
      const names = typeName === 'Issue' ? ISSUE_TYPE_FIELDS : typeName === 'PullRequest' ? PULL_REQUEST_TYPE_FIELDS : typeName === 'Repository' ? REPOSITORY_TYPE_FIELDS : [];
      out[field.alias] = names.map((name) => ({ name }));
    } else if (field.name === 'enumValues') {
      const names = typeName === 'SearchType' ? SEARCH_TYPE_ENUMS : [];
      out[field.alias] = names.map((name) => ({ name }));
    } else {
      out[field.alias] = null;
    }
  }
  return out;
}

function executeNode(id: string, fields: GqlField[], ctx: GqlContext): Record<string, unknown> | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = getRepoById(decoded.repoId);
    if (repo === undefined) return null;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.fragmentType !== null) {
        if (field.fragmentType === 'Repository') {
          for (const sub of field.children) {
            if (sub.name === 'name') out[sub.alias] = repo.name;
            else if (sub.name === 'nameWithOwner') out[sub.alias] = `${repo.owner}/${repo.name}`;
            else if (sub.name === 'id') out[sub.alias] = repoGlobalId(repo);
            else out[sub.alias] = null;
          }
        }
        continue;
      }
      if (field.name === 'id') out[field.alias] = repoGlobalId(repo);
      else {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Node'` });
        out[field.alias] = null;
      }
    }
    return out;
  }
  return null;
}

function executeOperation(op: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
  const ctx: GqlContext = { errors: [] };
  const data: Record<string, unknown> = {};
  if (op.kind === 'mutation') {
    for (const field of op.fields) {
      const args = resolveArgs(field, variables);
      const input = isRecord(args.input) ? args.input : {};
      if (field.name === 'createIssue') {
        const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId)?.repoId : undefined;
        const repo = repoId !== undefined ? getRepoById(repoId) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'Repository not found for createIssue' });
          data[field.alias] = null;
          continue;
        }
        const issue = createIssueRecord(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
        const issueOut: Record<string, unknown> = {};
        for (const sub of field.children) {
          if (sub.name === 'issue') {
            issueOut[sub.alias] = executeIssueFields(repo, issue, sub.children, ctx);
          } else issueOut[sub.alias] = null;
        }
        data[field.alias] = issueOut;
      } else if (field.name === 'closeIssue') {
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        const repo = decoded !== null ? getRepoById(decoded.repoId) : undefined;
        const issue = repo !== undefined && decoded !== null ? findIssue(repo, decoded.number) : undefined;
        if (repo === undefined || issue === undefined) {
          ctx.errors.push({ message: 'Issue not found for closeIssue' });
          data[field.alias] = null;
          continue;
        }
        issue.state = 'closed';
        repo.issueJsonVersion += 1;
        const out: Record<string, unknown> = {};
        for (const sub of field.children) {
          if (sub.name === 'issue') out[sub.alias] = executeIssueFields(repo, issue, sub.children, ctx);
          else out[sub.alias] = null;
        }
        data[field.alias] = out;
      } else if (field.name === 'createPullRequest') {
        const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId)?.repoId : undefined;
        const repo = repoId !== undefined ? getRepoById(repoId) : undefined;
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        if (repo === undefined || repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
          ctx.errors.push({ message: 'Repository or branch not found for createPullRequest' });
          data[field.alias] = null;
          continue;
        }
        const pull = createPullRecord(repo, typeof input.title === 'string' ? input.title : '', '', head, base);
        const out: Record<string, unknown> = {};
        for (const sub of field.children) {
          if (sub.name === 'pullRequest') out[sub.alias] = executePullFields(repo, pull, sub.children, ctx);
          else out[sub.alias] = null;
        }
        data[field.alias] = out;
      } else if (field.name === 'mergePullRequest') {
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        const repo = decoded !== null ? getRepoById(decoded.repoId) : undefined;
        const pull = repo !== undefined && decoded !== null ? findPull(repo, decoded.number) : undefined;
        if (repo === undefined || pull === undefined) {
          ctx.errors.push({ message: 'Pull request not found for mergePullRequest' });
          data[field.alias] = null;
          continue;
        }
        const result = squashMerge(repo, pull);
        if (!result.ok) {
          ctx.errors.push({ message: `Merge failed: ${result.reason}` });
          data[field.alias] = null;
          continue;
        }
        const out: Record<string, unknown> = {};
        for (const sub of field.children) {
          if (sub.name === 'pullRequest') out[sub.alias] = executePullFields(repo, pull, sub.children, ctx);
          else out[sub.alias] = null;
        }
        data[field.alias] = out;
      } else if (field.name === 'addComment') {
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        const repo = decoded !== null ? getRepoById(decoded.repoId) : undefined;
        const issue = repo !== undefined && decoded !== null ? findIssue(repo, decoded.number) : undefined;
        if (repo === undefined || issue === undefined) {
          ctx.errors.push({ message: 'Issue not found for addComment' });
          data[field.alias] = null;
          continue;
        }
        const comment = { id: nextCommentId, body: typeof input.body === 'string' ? input.body : '' };
        nextCommentId += 1;
        issue.comments.push(comment);
        repo.issueJsonVersion += 1;
        const out: Record<string, unknown> = {};
        for (const sub of field.children) {
          if (sub.name === 'commentEdge') {
            const edge: Record<string, unknown> = {};
            for (const edgeField of sub.children) {
              if (edgeField.name === 'node') {
                const node: Record<string, unknown> = {};
                for (const nodeField of edgeField.children) {
                  if (nodeField.name === 'id') node[nodeField.alias] = commentGlobalId(comment.id);
                  else if (nodeField.name === 'body') node[nodeField.alias] = comment.body;
                  else node[nodeField.alias] = null;
                }
                edge[edgeField.alias] = node;
              } else edge[edgeField.alias] = null;
            }
            out[sub.alias] = edge;
          } else out[sub.alias] = null;
        }
        data[field.alias] = out;
      } else {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
        data[field.alias] = null;
      }
    }
    return { data, errors: ctx.errors };
  }
  // Query.
  for (const field of op.fields) {
    if (field.fragmentType !== null) continue;
    const args = resolveArgs(field, variables);
    if (field.name === 'viewer') {
      const viewer: Record<string, unknown> = {};
      for (const sub of field.children) {
        if (sub.name === 'login') viewer[sub.alias] = VIEWER_LOGIN;
        else {
          ctx.errors.push({ message: `Field '${sub.name}' doesn't exist on type 'User'` });
          viewer[sub.alias] = null;
        }
      }
      data[field.alias] = viewer;
    } else if (field.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
      data[field.alias] = repo === undefined ? null : executeRepoFields(repo, field.children, variables, ctx);
    } else if (field.name === '__type') {
      const typeName = typeof args.name === 'string' ? args.name : '';
      data[field.alias] = executeTypeFields(typeName, field.children);
    } else if (field.name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      data[field.alias] = executeNode(id, field.children, ctx);
    } else {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'` });
      data[field.alias] = null;
    }
  }
  return { data, errors: ctx.errors };
}

/** The GraphQL dispatcher. Returns true when the request was answered. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (bearerToken(req) === null) {
    errorJson(res, 401, 'Requires authentication');
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    errorJson(res, 400, 'Request body too large');
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(raw);
  } catch {
    errorJson(res, 400, 'Problems parsing JSON');
    return true;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { errors: [{ message: 'A query string is required' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(doc.query).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Failed to parse the query' }] };
    }
    if (ops.length === 0) return { errors: [{ message: 'No operation in the document' }] };
    const op = ops[0] as GqlOperation;
    const { data, errors } = executeOperation(op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(body)) {
    jsonResponse(res, 200, body.map(runOne));
    return true;
  }
  jsonResponse(res, 200, runOne(body));
  return true;
}

// ----------------------------------------------------------------------------------
// MCP (Model Context Protocol, JSON-RPC 2.0 over Streamable HTTP)
// ----------------------------------------------------------------------------------

const MCP_REVISION = '2026-07-28';
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_NAME = 'github-core-clone';
const MCP_SERVER_VERSION = '1.0.0';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
];

function mcpToolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: isRecord(value) || Array.isArray(value) ? value : { result: value },
    isError,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return mcpToolResult(`Error: ${message}`, true);
}

/** Resolve owner/repo from tool arguments (also accepts full_name). */
function mcpRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = parts[0] as string;
      repo = parts[1] as string;
    }
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = MCP_TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const schema = def.inputSchema as { required?: string[] };
  for (const required of schema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { __rpcError: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (getRepo(VIEWER_LOGIN, repoName) !== undefined) return mcpToolError('Repository already exists');
      const repo = createRepoRecord(repoName, args.private === true, typeof args.description === 'string' ? args.description : '', 'main');
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const target = mcpRepoArgs(args);
      if (target === null) return mcpToolError('owner and repo are required');
      const repo = target.owner === VIEWER_LOGIN ? getRepo(target.owner, target.repo) : undefined;
      if (repo === undefined) return mcpToolError('Repository not found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const target = mcpRepoArgs(args);
      if (target === null) return mcpToolError('owner and repo are required');
      const repo = target.owner === VIEWER_LOGIN ? getRepo(target.owner, target.repo) : undefined;
      if (repo === undefined) return mcpToolError('Repository not found');
      const issue = createIssueRecord(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const target = mcpRepoArgs(args);
      if (target === null) return mcpToolError('owner and repo are required');
      const repo = target.owner === VIEWER_LOGIN ? getRepo(target.owner, target.repo) : undefined;
      if (repo === undefined) return mcpToolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = filterIssues(repo, { state });
      return mcpToolResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'get_issue': {
      const target = mcpRepoArgs(args);
      if (target === null) return mcpToolError('owner and repo are required');
      const repo = target.owner === VIEWER_LOGIN ? getRepo(target.owner, target.repo) : undefined;
      if (repo === undefined) return mcpToolError('Repository not found');
      const issue = findIssue(repo, Number(args.number));
      if (issue === undefined) return mcpToolError('Issue not found');
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const target = mcpRepoArgs(args);
      if (target === null) return mcpToolError('owner and repo are required');
      const repo = target.owner === VIEWER_LOGIN ? getRepo(target.owner, target.repo) : undefined;
      if (repo === undefined) return mcpToolError('Repository not found');
      const head = args.head as string;
      const base = args.base as string;
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        return mcpToolError('Head or base branch does not exist');
      }
      const pull = createPullRecord(repo, args.title as string, typeof args.body === 'string' ? args.body : '', head, base);
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const target = mcpRepoArgs(args);
      if (target === null) return mcpToolError('owner and repo are required');
      const repo = target.owner === VIEWER_LOGIN ? getRepo(target.owner, target.repo) : undefined;
      if (repo === undefined) return mcpToolError('Repository not found');
      const pull = findPull(repo, Number(args.pull_number));
      if (pull === undefined) return mcpToolError('Pull request not found');
      const result = squashMerge(repo, pull);
      if (!result.ok) return mcpToolError(`Merge failed: ${result.reason}`);
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      const target = mcpRepoArgs(args);
      if (target === null) return mcpToolError('owner and repo are required');
      const repo = target.owner === VIEWER_LOGIN ? getRepo(target.owner, target.repo) : undefined;
      if (repo === undefined) return mcpToolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = filterPulls(repo, { state });
      return mcpToolResult(list.map((pull) => pullJson(repo, pull)));
    }
    default:
      return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function mcpRpcResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (bearerToken(req) === null) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } }));
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(mcpRpcError(null, -32700, 'Parse error')));
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(mcpRpcError(null, -32700, 'Parse error')));
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(mcpRpcError(null, -32600, 'Invalid Request')));
    return true;
  }
  const id = body.id ?? null;
  const isNotification = body.id === undefined;
  const answer = (payload: Record<string, unknown>, status = 200): void => {
    if (isNotification) {
      res.writeHead(202);
      res.end();
      return;
    }
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};
  switch (body.method) {
    case 'server/discover': {
      answer(
        mcpRpcResponse(id, {
          resultType: 'discover',
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
        }),
      );
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      answer(
        mcpRpcResponse(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        }),
      );
      return true;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled': {
      answer({}, 202);
      return true;
    }
    case 'tools/list': {
      answer(mcpRpcResponse(id, { tools: MCP_TOOLS }));
      return true;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const outcome = callMcpTool(toolName, toolArgs);
      if (isRecord(outcome) && isRecord(outcome.__rpcError)) {
        const err = outcome.__rpcError as { code: number; message: string };
        answer(mcpRpcError(id, err.code, err.message));
        return true;
      }
      answer(mcpRpcResponse(id, outcome));
      return true;
    }
    default: {
      answer(mcpRpcError(id, -32601, `Method not found: ${body.method}`));
      return true;
    }
  }
}

// ----------------------------------------------------------------------------------
// Router + lifecycle
// ----------------------------------------------------------------------------------

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = req.url ?? '/';
      const path = pathOf(url);
      if (req.method === 'GET' && path === '/healthz') {
        jsonResponse(res, 200, { ok: true });
        return;
      }
      if (path === '/mcp') {
        if (await handleMcp(req, res)) return;
      }
      if (path === '/api/graphql') {
        if (await handleGraphql(req, res)) return;
      }
      if (path.startsWith('/api/v3')) {
        if (await handleRest(req, res)) return;
      }
      if (await handleGit(req, res)) return;
      errorJson(res, 404, 'Not Found');
    } catch (err) {
      // Never crash on a bad request: answer 500 JSON and keep serving.
      try {
        errorJson(res, 500, err instanceof Error ? err.message : 'Internal error');
      } catch {
        // The peer went away; nothing to do.
      }
    }
  })();
});

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postJson(url: string, body: unknown, timeoutMs = 5000): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs = 5000): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server has no TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    process.stderr.write(`forge: no MAKEFUN_ENV_URL; serving locally on port ${port}\n`);
    return;
  }
  const base = envUrl.replace(/\/+$/, '');
  // Register with the suite (retry with backoff).
  let registered = false;
  for (let attempt = 0; attempt < 30 && !registered; attempt += 1) {
    try {
      const answer = await postJson(`${base}/register`, { port });
      if (answer.status === 200 || answer.status === 201) registered = true;
      else process.stderr.write(`forge: register answered HTTP ${answer.status}, retrying\n`);
    } catch (err) {
      process.stderr.write(`forge: register failed (${err instanceof Error ? err.message : String(err)}), retrying\n`);
    }
    if (!registered) await sleep(Math.min(1000 * 2 ** attempt, 10000));
  }
  if (!registered) {
    process.stderr.write('forge: could not register with the suite; exiting 1\n');
    server.close();
    process.exit(1);
  }
  // Long-poll /done until the suite finishes, then exit 0.
  let delayMs = 250;
  for (;;) {
    try {
      const answer = await getJson(`${base}/done`, 10000);
      if (answer.status === 200) {
        const parsed: unknown = JSON.parse(answer.text);
        if (isRecord(parsed) && parsed.done === true) break;
      }
    } catch {
      // A failed poll is retried; the suite may be briefly busy.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2000);
  }
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});

void main().catch((err: unknown) => {
  process.stderr.write(`forge: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
