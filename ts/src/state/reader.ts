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

import { scanLines } from "./jsonl.js";
import type { JsonlSnapshot } from "./types.js";

/**
 * Tail this many bytes when we DO re-read. Enough to cover the last
 * ~50 entries even on a chatty session, far cheaper than reading
 * 3 MB. Mirrors `JsonlReader.TAIL_BYTES` in the Python build.
 */
export const TAIL_BYTES = 65_536;

interface CacheEntry {
  size: number;
  snapshot: JsonlSnapshot;
}

export class JsonlReader {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * Read or refresh the snapshot for `path`. Returns null when the
   * file doesn't exist (or has disappeared since the cache was last
   * filled).
   */
  read(path: string): JsonlSnapshot | null {
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

    const snapshot = this.scanTail(path, size, mtime);
    this.cache.set(path, { size, snapshot });
    return snapshot;
  }

  /**
   * Read up to TAIL_BYTES from the end of the file and scan it as
   * JSONL. If we sliced mid-line we drop the leading partial line
   * to keep the parser honest.
   */
  private scanTail(path: string, size: number, mtime: number): JsonlSnapshot {
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      readSync(fd, buf, 0, length, start);
    } catch {
      // File raced out from under us; return an empty snapshot.
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed or invalid
        }
      }
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
    closeSync(fd);

    let blob = buf.toString("utf8");
    if (start > 0) {
      // Drop the leading partial line.
      const nl = blob.indexOf("\n");
      if (nl === -1) {
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
      blob = blob.slice(nl + 1);
    }

    return scanLines(blob, mtime);
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
