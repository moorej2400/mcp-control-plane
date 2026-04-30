import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanup } from "../src/cleanup.mjs";
import { parsePsRows } from "../src/processes.mjs";

const cleanupPatterns = [{ name: "chrome-devtools", pattern: /chrome-devtools-mcp/ }];

const initialRows = parsePsRows(`
21566 21112 21112 23:39:05 S 1200 0.0 0:00.10 /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled
23049 21566 23049 23:38:59 S 50848 0.0 0:03.00 npm exec chrome-devtools-mcp@latest --autoConnect
23918 21566 23918 00:20:00 S 50848 0.0 0:01.00 npm exec chrome-devtools-mcp@latest --autoConnect
`, { cleanupPatterns });

test("cleanup dry run returns candidates without killing", async () => {
  const killed = [];
  const result = await cleanup({
    getRows: async () => initialRows,
    kill: (...args) => killed.push(args),
    minimumAgeSeconds: 600,
  });

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.pid),
    [23049]
  );
  assert.equal(result.summary.count, 1);
  assert.deepEqual(killed, []);
});

test("cleanup apply skips process groups with CPU activity", async () => {
  const rowsAfterCpu = initialRows.map((row) =>
    row.pgid === 23049 ? { ...row, cpuTimeSeconds: row.cpuTimeSeconds + 1 } : row
  );
  const killed = [];
  const snapshots = [initialRows, initialRows, rowsAfterCpu];

  const result = await cleanup({
    apply: true,
    getRows: async () => snapshots.shift() ?? rowsAfterCpu,
    kill: (...args) => killed.push(args),
    minimumAgeSeconds: 600,
    sampleMs: 0,
    sleep: async () => {},
  });

  assert.equal(result.skipped.length, 1);
  assert.deepEqual(killed, []);
});

test("cleanup apply SIGKILLs process groups still present after grace", async () => {
  const killed = [];
  const snapshots = [initialRows, initialRows, initialRows, initialRows];

  const result = await cleanup({
    apply: true,
    getRows: async () => snapshots.shift() ?? initialRows,
    kill: (...args) => killed.push(args),
    minimumAgeSeconds: 600,
    sampleMs: 0,
    sleep: async () => {},
  });

  assert.deepEqual(killed, [
    [-23049, "SIGTERM"],
    [-23049, "SIGKILL"],
  ]);
  assert.deepEqual(
    result.killed.map((entry) => entry.signal),
    ["SIGTERM", "SIGKILL"]
  );
});
