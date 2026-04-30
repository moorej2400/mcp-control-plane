import { spawn } from "node:child_process";

import { checkHealth, startService } from "./supervisor.mjs";

const MCP_REMOTE_VERSION = "0.1.38";

export async function connectService(specs, name, options = {}) {
  const spec = specs[name];
  if (!spec) throw new Error(`unknown MCP service: ${name}`);

  if (spec.bridgeTransport === "stdio-direct") {
    return runDirectStdio(spec, options);
  }

  if (spec.managed !== false) {
    await startService(spec, { quiet: true });
    await waitForHealthy(spec, options);
  }

  if (spec.bridgeTransport === "sse-only") {
    return runSseBridge(spec, options);
  }

  if (spec.bridgeTransport === "streamable-http") {
    return runHttpBridge(spec, options);
  }

  return runBridge(spec, options);
}

export function buildBridgeArgs(spec) {
  const args = [
    "-y",
    `mcp-remote@${MCP_REMOTE_VERSION}`,
    spec.bridgeUrl ?? spec.url,
    "--allow-http",
    "--transport",
    spec.bridgeTransport ?? "http-only",
  ];

  for (const [key, value] of Object.entries(spec.codexHeaders)) {
    args.push("--header", `${key}:${value}`);
  }

  return args;
}

async function waitForHealthy(
  spec,
  { healthTimeoutMs = 20_000, retryDelayMs = 250, sleep = delay } = {}
) {
  const deadline = Date.now() + healthTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await checkHealth(spec);
      return;
    } catch (error) {
      lastError = error;
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`${spec.name} did not become healthy: ${lastError?.message ?? "timeout"}`);
}

function runBridge(spec, { spawnFn = spawn } = {}) {
  const child = spawnFn("npx", buildBridgeArgs(spec), {
    cwd: spec.cwd,
    env: process.env,
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function runDirectStdio(spec, { errorOutput = process.stderr, input = process.stdin, output = process.stdout, spawnFn = spawn } = {}) {
  const [command, ...args] = spec.command;
  const child = spawnFn(command, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  input.pipe(child.stdin);
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer = filterJsonLines(stdoutBuffer + chunk, { errorOutput, output });
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (stdoutBuffer.trim()) {
        stdoutBuffer = filterJsonLines(`${stdoutBuffer}\n`, { errorOutput, output });
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export function filterJsonLines(buffer, { errorOutput, output }) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s*[\[{]/.test(line)) {
      output.write(`${line}\n`);
    } else {
      errorOutput.write(`${line}\n`);
    }
  }
  return remainder;
}

export async function runSseBridge(
  spec,
  {
    errorOutput = process.stderr,
    exitOnInputEndMs = 750,
    fetchFn = fetch,
    input = process.stdin,
    output = process.stdout,
  } = {}
) {
  const abortController = new AbortController();
  const endpoint = deferred();
  let inputEnded = false;
  let pendingPosts = Promise.resolve();

  const streamTask = readSseStream({
    abortController,
    endpoint,
    errorOutput,
    fetchFn,
    output,
    spec,
  });

  input.setEncoding("utf8");
  let buffered = "";
  input.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (handleLocalBridgeMessage({ line, output })) continue;
      pendingPosts = pendingPosts.then(() =>
        postSseMessage({ endpoint, errorOutput, fetchFn, line, spec })
      );
    }
  });
  input.on("end", () => {
    inputEnded = true;
    if (buffered.trim()) {
      if (!handleLocalBridgeMessage({ line: buffered, output })) {
        pendingPosts = pendingPosts.then(() =>
          postSseMessage({ endpoint, errorOutput, fetchFn, line: buffered, spec })
        );
      }
    }
    pendingPosts.finally(() => {
      setTimeout(() => abortController.abort(), exitOnInputEndMs).unref();
    });
  });

  await streamTask;
  await pendingPosts;
  return inputEnded ? 0 : 1;
}

export async function runHttpBridge(
  spec,
  {
    errorOutput = process.stderr,
    exitOnInputEndMs = 750,
    fetchFn = fetch,
    input = process.stdin,
    output = process.stdout,
  } = {}
) {
  let inputEnded = false;
  let pendingPosts = Promise.resolve();
  let sessionId = null;
  const inputEndedTask = new Promise((resolve) => input.on("end", resolve));

  input.setEncoding("utf8");
  let buffered = "";
  input.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      pendingPosts = pendingPosts.then(async () => {
        sessionId = await postHttpMessage({ errorOutput, fetchFn, line, output, sessionId, spec });
      });
    }
  });
  input.on("end", () => {
    inputEnded = true;
    if (buffered.trim()) {
      pendingPosts = pendingPosts.then(async () => {
        sessionId = await postHttpMessage({
          errorOutput,
          fetchFn,
          line: buffered,
          output,
          sessionId,
          spec,
        });
      });
    }
  });

  await inputEndedTask;
  await pendingPosts;
  await delay(exitOnInputEndMs);
  return inputEnded ? 0 : 1;
}

async function readSseStream({ abortController, endpoint, errorOutput, fetchFn, output, spec }) {
  const response = await fetchFn(spec.bridgeUrl, {
    headers: {
      accept: "text/event-stream",
      ...spec.codexHeaders,
    },
    signal: abortController.signal,
  });

  if (!response.ok) {
    throw new Error(`${spec.name} SSE bridge failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = processSseBuffer(buffer, {
        endpoint,
        errorOutput,
        output,
        baseUrl: spec.bridgeUrl,
      });
    }
  } catch (error) {
    if (abortController.signal.aborted) return;
    throw error;
  }
}

export function processSseBuffer(buffer, { baseUrl, endpoint, errorOutput, output }) {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";
  for (const part of parts) {
    const event = parseSseEvent(part);
    if (!event.data) continue;
    if (event.type === "endpoint") {
      endpoint.resolve(new URL(event.data, baseUrl));
      continue;
    }
    if (!event.type || event.type === "message") {
      if (isProxyLogNotification(event.data)) continue;
      output.write(`${event.data}\n`);
      continue;
    }
    errorOutput.write(`ignored SSE event type=${event.type}\n`);
  }
  return remainder;
}

export function handleLocalBridgeMessage({ line, output }) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }

  // Client shutdown is scoped to this stdio bridge. Forwarding it would stop
  // the shared mcp-proxy child and break other Codex sessions reusing it.
  if (message?.method === "shutdown" && message.id !== undefined) {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null })}\n`);
    return true;
  }

  if (message?.method === "exit") {
    return true;
  }

  return false;
}

function isProxyLogNotification(data) {
  try {
    const message = JSON.parse(data);
    return message?.method === "notifications/message";
  } catch {
    return false;
  }
}

function parseSseEvent(part) {
  let type = "";
  const data = [];
  for (const line of part.split(/\r?\n/)) {
    if (line.startsWith("event:")) type = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return { data: data.join("\n"), type };
}

async function postSseMessage({ endpoint, errorOutput, fetchFn, line, spec }) {
  const url = await endpoint.promise;
  const response = await fetchFn(url, {
    body: line,
    headers: {
      "content-type": "application/json",
      ...spec.codexHeaders,
    },
    method: "POST",
  });
  if (!response.ok) {
    errorOutput.write(`${spec.name} SSE POST failed: HTTP ${response.status}\n`);
  }
}

async function postHttpMessage({ errorOutput, fetchFn, line, output, sessionId, spec }) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...spec.codexHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetchFn(spec.url, {
    body: line,
    headers,
    method: "POST",
  });
  const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;

  if (!response.ok) {
    errorOutput.write(`${spec.name} HTTP bridge failed: HTTP ${response.status}\n`);
    return nextSessionId;
  }

  const text = await response.text();
  if (!text.trim()) return nextSessionId;
  writeHttpResponse({ baseUrl: spec.url, errorOutput, output, text, type: response.headers.get("content-type") });
  return nextSessionId;
}

export function writeHttpResponse({ baseUrl, errorOutput, output, text, type }) {
  if (type?.includes("text/event-stream")) {
    processSseBuffer(text.endsWith("\n\n") ? text : `${text}\n\n`, {
      baseUrl,
      endpoint: { resolve() {} },
      errorOutput,
      output,
    });
    return;
  }

  output.write(`${text.trimEnd()}\n`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
