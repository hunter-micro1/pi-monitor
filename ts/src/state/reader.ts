/**
 * Cached tail-reader for session JSONL files.
 *
 * Direct port of the `JsonlReader` class in
 * `src/pi_monitor/state.py`. Caches `(path -> { size, snapshot })`
 * so each tick is O(delta): if the file size hasn't grown, we hand
 * back the cached snapshot with a refreshed mtime; otherwise we
 * re-tail the last 64 KB and re-scan.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

import { type Harness, piHarness } from "../harness/index.js";
import { scanLines } from "./jsonl.js";
import type { JsonlSnapshot } from "./types.js";

/**
 * Bytes tailed on the first attempt. Enough to cover the last ~50
 * entries of a pi session, far cheaper than reading 3 MB. Mirrors
 * `JsonlReader.TAIL_BYTES` in the Python build.
 */
export const TAIL_BYTES = 65_536;

/**
 * Ceiling on the adaptive re-read (see `scanTail`). A session whose
 * last conversational record is more than this far from EOF resolves
 * to `unknown`, which is the honest answer — but at 8 MB that would
 * take a truly pathological file, and the bound keeps a corrupt or
 * adversarial file from turning every tick into a full read.
 */
export const MAX_TAIL_BYTES = 8_388_608;

function emptySnapshot(mtime: number): JsonlSnapshot {
  return {
    mtime,
    lastRole: null,
    lastStopReason: null,
    lastError: null,
    pendingToolCalls: 0,
    lastAssistantPreview: null,
    lastUserPrompt: null,
    cumulativeTokens: 0,
    cumulativeCostUsd: 0,
  };
}

interface CacheEntry {
  size: number;
  snapshot: JsonlSnapshot;
  /**
   * Window that actually yielded a conversational record for this
   * file. Remembered so a session with chronic attachment noise
   * doesn't re-discover the same growth sequence on every tick —
   * it starts where it succeeded last time.
   */
  window: number;
}

export class JsonlReader {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * Read or refresh the snapshot for `path`. Returns null when the
   * file doesn't exist (or has disappeared since the cache was last
   * filled).
   *
   * `harness` selects the record parser. Caching by path alone is
   * safe because a given session file belongs to exactly one harness
   * — the two write to disjoint directory trees.
   */
  read(path: string, harness: Harness = piHarness): JsonlSnapshot | null {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      this.cache.delete(path);
      return null;
    }
    const size = stat.size;
    const mtime = stat.mtimeMs / 1000;

    const cached = this.cache.get(path);
    if (cached !== undefined && cached.size === size) {
      // File untouched since last read; mtime CAN differ if it was
      // truncated-and-rewritten to the same size, but pi only
      // appends. Refresh mtime onto the cached snapshot and reuse.
      cached.snapshot.mtime = mtime;
      return cached.snapshot;
    }

    const startWindow = Math.max(TAIL_BYTES, cached?.window ?? 0);
    const { snapshot, window } = this.scanTail(path, size, mtime, harness, startWindow);
    this.cache.set(path, { size, snapshot, window });
    return snapshot;
  }

  /**
   * Scan the tail of the file, growing the window until it contains a
   * conversational record.
   *
   * A fixed window is wrong for harnesses that interleave large
   * non-conversational records between turns. Claude Code writes
   * `attachment` entries averaging ~3 KB (54 KB at the top end); on a
   * real session the last actual turn sat 226 KB from EOF, so a
   * 64 KB tail parsed nothing but attachments, yielded
   * `lastRole: null`, and pinned a healthy pane to `unknown`.
   *
   * Doubling from `startWindow` costs one extra read only on files
   * that need it, and the caller remembers the winning window so the
   * growth isn't rediscovered every tick. Stops at the file start or
   * `MAX_TAIL_BYTES`, whichever comes first.
   */
  private scanTail(
    path: string,
    size: number,
    mtime: number,
    harness: Harness,
    startWindow: number,
  ): { snapshot: JsonlSnapshot; window: number } {
    let window = Math.min(Math.max(startWindow, TAIL_BYTES), MAX_TAIL_BYTES);
    let snapshot = emptySnapshot(mtime);

    while (true) {
      const blob = this.readWindow(path, size, window);
      if (blob === null) {
        // File raced out from under us; hand back an empty snapshot.
        return { snapshot: emptySnapshot(mtime), window };
      }
      snapshot = scanLines(blob, mtime, harness);

      const sawWholeFile = window >= size;
      if (snapshot.lastRole !== null || sawWholeFile || window >= MAX_TAIL_BYTES) {
        return { snapshot, window };
      }
      window = Math.min(window * 2, MAX_TAIL_BYTES);
    }
  }

  /**
   * Read the last `window` bytes of `path` as UTF-8, dropping a
   * leading partial line when the slice starts mid-record. Returns
   * `null` when the file can't be read, and `""` when the slice
   * contains no line boundary at all.
   */
  private readWindow(path: string, size: number, window: number): string | null {
    const start = Math.max(0, size - window);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      readSync(fd, buf, 0, length, start);
    } catch {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed or invalid
        }
      }
      return null;
    }
    closeSync(fd);

    const blob = buf.toString("utf8");
    if (start === 0) return blob;
    // Drop the leading partial line so the parser never sees a
    // half-record.
    const nl = blob.indexOf("\n");
    return nl === -1 ? "" : blob.slice(nl + 1);
  }

  /**
   * Drop the cache. Tests can call this between cases; production
   * callers don't need to (the cache is keyed by path and self-
   * invalidates when sizes change).
   */
  clear(): void {
    this.cache.clear();
  }
}
