import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBridgeArgs,
  filterJsonLines,
  handleLocalBridgeMessage,
  processSseBuffer,
  writeHttpResponse,
} from "../src/connect.mjs";

test("buildBridgeArgs connects stdio clients to shared HTTP MCP endpoint", () => {
  assert.deepEqual(
    buildBridgeArgs({
      bridgeTransport: "streamable-http",
      codexHeaders: { Authorization: "Token test-token" },
      url: "http://127.0.0.1:49001/mcp",
    }),
    [
      "-y",
      "mcp-remote@0.1.38",
      "http://127.0.0.1:49001/mcp",
      "--allow-http",
      "--transport",
      "streamable-http",
      "--header",
      "Authorization:Token test-token",
    ]
  );
});

test("buildBridgeArgs can use a separate bridge URL and transport", () => {
  const args = buildBridgeArgs({
    bridgeTransport: "sse-only",
    bridgeUrl: "http://127.0.0.1:49002/sse",
    codexHeaders: { "X-API-Key": "proxy-token" },
    url: "http://127.0.0.1:49002/mcp",
  });

  assert.equal(args[2], "http://127.0.0.1:49002/sse");
  assert.deepEqual(args.slice(4, 8), ["--transport", "sse-only", "--header", "X-API-Key:proxy-token"]);
});

test("processSseBuffer captures endpoint events and writes message events", () => {
  const output = writer();
  const errorOutput = writer();
  const endpoint = { value: null, resolve(value) { this.value = value; } };

  const remainder = processSseBuffer(
    [
      "event: endpoint",
      "data: /message?session=abc",
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{}}',
      "",
      "event: ping",
    ].join("\n"),
    {
      baseUrl: "http://127.0.0.1:49002/sse",
      endpoint,
      errorOutput,
      output,
    }
  );

  assert.equal(String(endpoint.value), "http://127.0.0.1:49002/message?session=abc");
  assert.equal(output.text, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.equal(errorOutput.text, "");
  assert.equal(remainder, "event: ping");
});

test("processSseBuffer suppresses proxy log notifications", () => {
  const output = writer();
  processSseBuffer(
    [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}',
      "",
    ].join("\n"),
    {
      baseUrl: "http://127.0.0.1:49002/sse",
      endpoint: { resolve() {} },
      errorOutput: writer(),
      output,
    }
  );

  assert.equal(output.text, "");
});

test("handleLocalBridgeMessage keeps client shutdown from stopping shared daemon", () => {
  const output = writer();

  assert.equal(
    handleLocalBridgeMessage({
      line: '{"jsonrpc":"2.0","id":5,"method":"shutdown"}',
      output,
    }),
    true
  );
  assert.equal(output.text, '{"jsonrpc":"2.0","id":5,"result":null}\n');
});

test("handleLocalBridgeMessage swallows client exit notifications", () => {
  const output = writer();

  assert.equal(
    handleLocalBridgeMessage({
      line: '{"jsonrpc":"2.0","method":"exit"}',
      output,
    }),
    true
  );
  assert.equal(output.text, "");
});

test("writeHttpResponse emits JSON and SSE MCP responses as JSONL", () => {
  const jsonOutput = writer();
  writeHttpResponse({
    baseUrl: "http://127.0.0.1:49001/mcp",
    errorOutput: writer(),
    output: jsonOutput,
    text: '{"jsonrpc":"2.0","id":1,"result":{}}\n',
    type: "application/json",
  });

  const sseOutput = writer();
  writeHttpResponse({
    baseUrl: "http://127.0.0.1:49001/mcp",
    errorOutput: writer(),
    output: sseOutput,
    text: 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n',
    type: "text/event-stream",
  });

  assert.equal(jsonOutput.text, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.equal(sseOutput.text, '{"jsonrpc":"2.0","id":2,"result":{}}\n');
});

test("filterJsonLines diverts stdout startup logs away from MCP JSON", () => {
  const output = writer();
  const errorOutput = writer();

  let buffer = filterJsonLines("starting server\n{\"jsonrpc\":\"2.0\"", {
    errorOutput,
    output,
  });
  buffer = filterJsonLines(`${buffer},"id":1}\n`, { errorOutput, output });

  assert.equal(buffer, "");
  assert.equal(errorOutput.text, "starting server\n");
  assert.equal(output.text, '{"jsonrpc":"2.0","id":1}\n');
});

function writer() {
  return {
    text: "",
    write(chunk) {
      this.text += chunk;
    },
  };
}
