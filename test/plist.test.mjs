import assert from "node:assert/strict";
import { test } from "node:test";

import { renderLaunchAgentPlist } from "../src/plist.mjs";

test("renderLaunchAgentPlist pins launchd job to mcpctl subcommand", () => {
  const plist = renderLaunchAgentPlist({
    args: ["start", "--quiet"],
    label: "com.mcp-control-plane.control",
    logDir: "/opt/example/.mcp-control-plane/logs",
    program: "/opt/example/mcp-control-plane/bin/mcpctl.mjs",
  });

  assert.match(plist, /<key>Label<\/key>\s*<string>com\.mcp-control-plane\.control<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /<string>--quiet<\/string>/);
  assert.match(plist, /\/opt\/example\/\.mcp-control-plane\/logs\/com\.mcp-control-plane\.control\.out\.log/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
});
