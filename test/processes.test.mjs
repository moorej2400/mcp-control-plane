import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyProcess,
  findCleanupCandidates,
  parsePsRows,
} from "../src/processes.mjs";

const samplePs = `
  PID  PPID  PGID     ELAPSED STAT   RSS COMMAND
21566 21112 21112    23:39:05 S    1200 /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled
23049 21566 23049    23:38:59 S   50848 npm exec chrome-devtools-mcp@latest --autoConnect
23366 23049 23049    23:38:58 S  105000 chrome-devtools-mcp
23918 21566 23918       08:00 S   50848 npm exec chrome-devtools-mcp@latest --autoConnect
23964 23918 23918       07:59 S  105000 chrome-devtools-mcp
50377 1646 50377        02:08 S   60000 node /opt/example/node/bin/codex --dangerously-bypass-approvals-and-sandbox
50554 50377 50554       02:06 S   50848 npm exec chrome-devtools-mcp@latest --autoConnect
50841 50554 50554       02:05 S  105000 chrome-devtools-mcp
`;

const orphanPs = `
  PID  PPID  PGID     ELAPSED STAT   RSS COMMAND
69427 1 69427     01-05:23:41 S   36112 node /Users/example/mcp-control-plane/bin/mcpctl.mjs connect chrome-devtools
69531 69427 69427 01-05:23:40 S   49024 npm exec chrome-devtools-mcp@0.23.0 --autoConnect
`;

const cleanupPatterns = [
  { name: "chrome-devtools", pattern: /chrome-devtools-mcp/ },
  { name: "notionApi", pattern: /notion-mcp-server|@notionhq\/notion-mcp-server/ },
  { name: "shortcuts-mcp", pattern: /shortcuts-mcp/ },
];

test("classifyProcess identifies known MCP commands", () => {
  assert.equal(
    classifyProcess("npm exec @notionhq/notion-mcp-server", cleanupPatterns),
    "notionApi"
  );
  assert.equal(
    classifyProcess("node /opt/example/apps/shortcuts-mcp/dist/server.js", cleanupPatterns),
    "shortcuts-mcp"
  );
  assert.equal(classifyProcess("node app.js", cleanupPatterns), null);
});

test("findCleanupCandidates keeps newest duplicate and current root", () => {
  const rows = parsePsRows(samplePs, { cleanupPatterns });
  const candidates = findCleanupCandidates(rows, {
    currentRootPids: new Set([50377]),
    minimumAgeSeconds: 600,
    nowSeconds: 24 * 60 * 60,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.pid),
    [23049]
  );
  assert.equal(candidates[0].reason, "older duplicate chrome-devtools under root 21566");
});

test("findCleanupCandidates includes orphaned configured MCP roots", () => {
  const rows = parsePsRows(`${samplePs}\n${orphanPs}`, { cleanupPatterns });
  const candidates = findCleanupCandidates(rows, {
    currentRootPids: new Set([50377]),
    minimumAgeSeconds: 600,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.pid),
    [23049, 69427]
  );
  assert.equal(candidates[1].reason, "orphaned chrome-devtools process group");
});

test("findCleanupCandidates skips protected orphaned roots", () => {
  const rows = parsePsRows(orphanPs, { cleanupPatterns });
  const candidates = findCleanupCandidates(rows, {
    currentRootPids: new Set([69427]),
    minimumAgeSeconds: 600,
  });

  assert.deepEqual(candidates, []);
});

test("parsePsRows captures CPU fields when present", () => {
  const [row] = parsePsRows(
    "23049 21566 23049 23:38:59 S 50848 1.5 0:02.25 npm exec chrome-devtools-mcp@latest --autoConnect",
    { cleanupPatterns }
  );

  assert.equal(row.cpuPct, 1.5);
  assert.equal(row.cpuTimeSeconds, 2.25);
  assert.equal(row.command, "npm exec chrome-devtools-mcp@latest --autoConnect");
});
