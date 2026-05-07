/**
 * Heartbeat reader tests.
 *
 * Direct equivalents of the `test_read_*` block in
 * `tests/test_heartbeat.py`. The Python tests use pytest's `tmp_path`
 * fixture and monkeypatch HEARTBEATS_DIR; we use a fresh tmp dir
 * via `node:fs` and pass `baseDir` through the reader's options
 * argument (cleaner than mutating a module-level constant in TS).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEARTBEAT_FRESHNESS_S,
  type Heartbeat,
  readHeartbeat,
} from "../../src/heartbeat/reader.js";

// ---------------------------------------------------------------------------
// Per-test tmp dir for heartbeat files
// ---------------------------------------------------------------------------

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "pi-mon-hb-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeHeartbeat(
  pid: number,
  fields: {
    ts: number;
    phase?: string;
    sessionFile?: string | null;
    currentTool?: string | null;
    retryAttempt?: number;
    version?: number;
    overridePid?: number;
  },
): string {
  const path = join(baseDir, `${pid}.json`);
  const payload = {
    version: fields.version ?? 1,
    pid: fields.overridePid ?? pid,
    session_file: fields.sessionFile ?? null,
    ts: fields.ts,
    phase: fields.phase ?? "agent_running",
    current_tool: fields.currentTool ?? null,
    retry_attempt: fields.retryAttempt ?? 0,
  };
  writeFileSync(path, `${JSON.stringify(payload)}\n`);
  return path;
}

function read(pid: number, nowSeconds?: number): Heartbeat | null {
  return readHeartbeat(pid, { baseDir, nowSeconds });
}

// ---------------------------------------------------------------------------
// Reader: parse correctness
// ---------------------------------------------------------------------------

describe("readHeartbeat", () => {
  it("returns null when the file is absent", () => {
    expect(read(12345, 1000.0)).toBeNull();
  });

  it("returns null when the file is malformed", () => {
    writeFileSync(join(baseDir, "12345.json"), "{not json");
    expect(read(12345, 1000.0)).toBeNull();
  });

  it("returns null when a required field is missing (no phase)", () => {
    writeFileSync(
      join(baseDir, "12345.json"),
      JSON.stringify({ version: 1, pid: 12345, ts: 1000.0 }),
    );
    expect(read(12345, 1000.0)).toBeNull();
  });

  it("returns null when the payload's pid disagrees with the filename", () => {
    // Defensive: a payload claiming a different pid than its filename
    // is suspicious. Treat as corrupt.
    writeHeartbeat(12345, {
      ts: 1000.0,
      phase: "idle",
      overridePid: 99999,
    });
    expect(read(12345, 1000.0)).toBeNull();
  });

  it("returns null when the heartbeat is stale", () => {
    writeHeartbeat(12345, { ts: 1000.0, phase: "agent_running" });
    // Far past the freshness window.
    expect(read(12345, 1000.0 + HEARTBEAT_FRESHNESS_S + 1.0)).toBeNull();
  });

  it("round-trips a fresh well-formed payload", () => {
    writeHeartbeat(12345, {
      ts: 1000.0,
      phase: "tool_running",
      sessionFile: "/abs/path/sess.jsonl",
      currentTool: "bash",
      retryAttempt: 0,
    });
    const hb = read(12345, 1000.5);
    expect(hb).not.toBeNull();
    expect(hb?.pid).toBe(12345);
    expect(hb?.phase).toBe("tool_running");
    expect(hb?.sessionFile).toBe("/abs/path/sess.jsonl");
    expect(hb?.currentTool).toBe("bash");
    expect(hb?.retryAttempt).toBe(0);
    expect(hb?.ts).toBe(1000.0);
  });

  it("tolerates unknown phase values (passes them through)", () => {
    // The reader returns the heartbeat with phase as-is. The state-
    // mapping layer is responsible for falling back when the phase
    // isn't one it knows about.
    writeHeartbeat(12345, { ts: 1000.0, phase: "future_state" });
    const hb = read(12345, 1000.5);
    expect(hb).not.toBeNull();
    expect(hb?.phase).toBe("future_state");
  });

  it("treats null session_file as null (not as the literal string)", () => {
    writeHeartbeat(12345, {
      ts: 1000.0,
      phase: "idle",
      sessionFile: null,
    });
    const hb = read(12345, 1000.5);
    expect(hb?.sessionFile).toBeNull();
  });

  it("rejects payloads where ts is not a number", () => {
    writeFileSync(
      join(baseDir, "12345.json"),
      JSON.stringify({
        version: 1,
        pid: 12345,
        ts: "not-a-number",
        phase: "idle",
      }),
    );
    expect(read(12345, 1000.0)).toBeNull();
  });

  it("rejects payloads where the top-level isn't an object", () => {
    writeFileSync(join(baseDir, "12345.json"), "[1, 2, 3]");
    expect(read(12345, 1000.0)).toBeNull();
    writeFileSync(join(baseDir, "12345.json"), '"some string"');
    expect(read(12345, 1000.0)).toBeNull();
  });

  it("clamps invalid retry_attempt values to 0", () => {
    // Defensive: a malformed retry_attempt shouldn't propagate as NaN
    // into PaneStatus. The Python reader uses the same defensive try/
    // except → 0.
    writeFileSync(
      join(baseDir, "12345.json"),
      JSON.stringify({
        version: 1,
        pid: 12345,
        ts: 1000.0,
        phase: "retrying",
        retry_attempt: "garbage",
      }),
    );
    const hb = read(12345, 1000.5);
    expect(hb).not.toBeNull();
    expect(hb?.retryAttempt).toBe(0);
  });

  it("uses Date.now()/1000 when nowSeconds is omitted", () => {
    writeHeartbeat(12345, {
      ts: Date.now() / 1000,
      phase: "agent_running",
    });
    // Should be fresh against current wall-clock.
    expect(readHeartbeat(12345, { baseDir })).not.toBeNull();
  });
});
