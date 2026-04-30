import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildContext } from "../src/context.mjs";

test("buildContext tolerates a missing Codex config for first-run commands", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mcp-context-"));
  const serviceConfigPath = path.join(temp, "services.json");
  await writeFile(
    serviceConfigPath,
    JSON.stringify({
      services: [
        {
          command: ["node", "server.js"],
          inheritEnv: ["EXAMPLE_TOKEN"],
          name: "example",
          transport: "stdio",
        },
      ],
    })
  );

  const context = await buildContext({
    codexConfigPath: path.join(temp, "missing-codex-config.toml"),
    controlHome: temp,
    serviceConfigPath,
  });

  assert.equal(context.codexConfig, "");
  assert.deepEqual(context.codexEnv, { example: {} });
  assert.equal(context.specs.example.managed, false);
});
