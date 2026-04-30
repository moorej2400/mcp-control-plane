import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseMcpEnv,
  previewCodexConfig,
  rewriteCodexConfig,
} from "../src/config.mjs";
import { MCPCTL } from "../src/services.mjs";

const inputConfig = `
[projects."/tmp/demo"]
trust_level = "trusted"

[mcp_servers.notionApi]
command = "npx"
args = ["-y", "@notionhq/notion-mcp-server"]

[mcp_servers.notionApi.env]
EXAMPLE_TOKEN = "redacted-test-token"

[mcp_servers."macos_automator"]
command = "npx"
args = ["-y", "@steipete/macos-automator-mcp@0.4.1"]

[mcp_servers.messages]
command = "uvx"
args = ["--with", "mcp==1.9.4", "mac-messages-mcp==0.7.3"]

[mcp_servers."cloudflare-api"]
url = "https://mcp.cloudflare.com/mcp"

[notice]
hide = true
`;

test("parseMcpEnv extracts simple env values from a server env block", () => {
  assert.deepEqual(parseMcpEnv(inputConfig, "notionApi"), {
    EXAMPLE_TOKEN: "redacted-test-token",
  });
});

test("rewriteCodexConfig replaces managed stdio blocks and keeps unrelated blocks", () => {
  const output = rewriteCodexConfig(inputConfig, {
    macos_automator: {
      codexHeaders: { "X-API-Key": "auto" },
      name: "macos_automator",
      url: "http://127.0.0.1:48761/mcp",
    },
    messages: {
      codexHeaders: { "X-API-Key": "msg" },
      name: "messages",
      url: "http://127.0.0.1:48771/mcp",
    },
    notionApi: {
      codexHeaders: { Authorization: "Bearer notion" },
      name: "notionApi",
      url: "http://127.0.0.1:48711/mcp",
    },
  });

  assert.match(
    output,
    new RegExp(
      `\\[mcp_servers\\.notionApi\\]\\ncommand = "node"\\nargs = \\["${escapeRegExp(MCPCTL)}", "connect", "notionApi"\\]`
    )
  );
  assert.match(output, /\[mcp_servers\."cloudflare-api"\]\nurl = "https:\/\/mcp\.cloudflare\.com\/mcp"/);
  assert.match(output, /\[notice\]\nhide = true/);
  assert.doesNotMatch(output, /EXAMPLE_TOKEN = "redacted-test-token"/);
  assert.doesNotMatch(output, /command = "uvx"/);
});

test("previewCodexConfig returns rewritten config without applying", async () => {
  const output = await previewCodexConfig({
    readFileFn: async () => inputConfig,
    specs: {
      notionApi: {
        name: "notionApi",
        url: "http://127.0.0.1:48711/mcp",
      },
    },
  });

  assert.match(output, /\[mcp_servers\.notionApi\]/);
  assert.doesNotMatch(output, /EXAMPLE_TOKEN = "redacted-test-token"/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
