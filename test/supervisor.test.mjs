import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkHealth, startService, stopServices } from "../src/supervisor.mjs";

test("startService spawns a detached service with log files", async () => {
  const controlHome = await mkdtemp(path.join(os.tmpdir(), "mcp-supervisor-"));
  const spec = {
    command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
    env: {},
    name: "demo",
  };

  const result = await startService(spec, { controlHome, quiet: true });

  assert.equal(result.action, "start");
  assert.equal(typeof result.pid, "number");
  assert.equal(Number(await readFile(path.join(controlHome, "pids", "demo.pid"), "utf8")), result.pid);

  await stopServices({ demo: spec }, { controlHome });
});

test("checkHealth uses fetch so HTTPS endpoints are supported", async () => {
  const calls = [];
  await checkHealth(
    {
      codexHeaders: { "X-API-Key": "test-token" },
      name: "remote",
      url: "https://example.com/mcp",
    },
    {
      fetchFn: async (url, options) => {
        calls.push({ options, url });
        return { ok: true, status: 200 };
      },
    }
  );

  assert.equal(calls[0].url, "https://example.com/mcp");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-API-Key"], "test-token");
});
