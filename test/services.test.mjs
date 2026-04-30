import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCleanupPatterns,
  buildCodexServerBlock,
  buildServiceSpecs,
  getServiceNames,
  MCPCTL,
  normalizeServiceDefinitions,
} from "../src/services.mjs";

const definitions = normalizeServiceDefinitions({
  services: [
    {
      cleanupPatterns: ["example-mcp"],
      command: ["npx", "-y", "example-mcp@1.0.0"],
      inheritEnv: ["EXAMPLE_TOKEN"],
      name: "example_stdio",
      transport: "stdio",
    },
    {
      command: ["node", "server.js"],
      cwd: "/tmp/example-http",
      env: { MCP_TRANSPORT: "http" },
      name: "example_http",
      transport: "streamable-http",
      url: "http://127.0.0.1:49001/mcp",
    },
    {
      command: ["node", "stdio-server.js"],
      name: "example_proxy",
      transport: "stdio-proxy",
      url: "http://127.0.0.1:49002/mcp",
    },
  ],
});
const directDefinitions = definitions.filter((definition) => definition.transport !== "stdio-proxy");

test("service definitions are config-driven and ordered", () => {
  assert.deepEqual(getServiceNames(definitions), [
    "example_stdio",
    "example_http",
    "example_proxy",
  ]);
});

test("stdio services run direct and preserve selected env from existing Codex config", () => {
  const specs = buildServiceSpecs({
    codexEnv: {
      example_stdio: {
        EXAMPLE_TOKEN: "secret",
        IGNORED: "nope",
      },
    },
    definitions: directDefinitions,
  });

  assert.deepEqual(specs.example_stdio.command, ["npx", "-y", "example-mcp@1.0.0"]);
  assert.equal(specs.example_stdio.bridgeTransport, "stdio-direct");
  assert.equal(specs.example_stdio.managed, false);
  assert.equal(specs.example_stdio.url, null);
  assert.deepEqual(specs.example_stdio.env, { EXAMPLE_TOKEN: "secret" });
});

test("streamable HTTP services are managed when they have a command", () => {
  const specs = buildServiceSpecs({ definitions: directDefinitions });

  assert.equal(specs.example_http.bridgeTransport, "streamable-http");
  assert.equal(specs.example_http.managed, true);
  assert.equal(specs.example_http.cwd, "/tmp/example-http");
  assert.deepEqual(specs.example_http.env, { MCP_TRANSPORT: "http" });
  assert.equal(specs.example_http.url, "http://127.0.0.1:49001/mcp");
});

test("stdio proxy services remain available as an explicit experimental option", () => {
  const specs = buildServiceSpecs({
    definitions,
    tokens: { example_proxy: "proxy-token" },
  });

  assert.equal(specs.example_proxy.bridgeTransport, "sse-only");
  assert.equal(specs.example_proxy.bridgeUrl, "http://127.0.0.1:49002/sse");
  assert.match(specs.example_proxy.command[2], /mcp-proxy@6\.4\.6/);
  assert.match(specs.example_proxy.command[2], /--apiKey proxy-token/);
});

test("stdio proxy services require persisted tokens", () => {
  assert.throws(
    () => buildServiceSpecs({ definitions }),
    /example_proxy requires a persisted token/
  );
});

test("service definitions validate config shape with clear errors", () => {
  assert.throws(
    () => normalizeServiceDefinitions({
      services: [
        {
          cleanupPatterns: ["["],
          command: ["node", "server.js"],
          name: "broken",
        },
      ],
    }),
    /broken\.cleanupPatterns contains invalid regex/
  );

  assert.throws(
    () => normalizeServiceDefinitions({
      services: [
        {
          command: ["node", "server.js"],
          env: { "bad-key": "value" },
          name: "broken",
        },
      ],
    }),
    /broken\.env contains invalid environment key/
  );
});

test("cleanup patterns are sourced from service config", () => {
  const patterns = buildCleanupPatterns(definitions);

  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].name, "example_stdio");
  assert.equal(patterns[0].pattern.test("npx example-mcp"), true);
});

test("Codex block autostarts through mcpctl connect", () => {
  const block = buildCodexServerBlock({
    name: "example",
  });

  assert.equal(
    block,
    [
      "[mcp_servers.example]",
      'command = "node"',
      `args = ["${MCPCTL}", "connect", "example"]`,
      "startup_timeout_sec = 60.0",
      "",
    ].join("\n")
  );
});

test("Codex block preserves service env for the wrapper process", () => {
  const block = buildCodexServerBlock({
    env: {
      EXAMPLE_TOKEN: "secret",
    },
    name: "example_stdio",
  });

  assert.equal(
    block,
    [
      "[mcp_servers.example_stdio]",
      'command = "node"',
      `args = ["${MCPCTL}", "connect", "example_stdio"]`,
      "startup_timeout_sec = 60.0",
      "",
      "[mcp_servers.example_stdio.env]",
      'EXAMPLE_TOKEN = "secret"',
      "",
    ].join("\n")
  );
});
