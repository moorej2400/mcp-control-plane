import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ensureState } from "../src/state.mjs";

test("ensureState creates and preserves one token per managed service", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mcp-control-state-"));
  const first = await ensureState({ controlHome: home, serviceNames: ["notionApi"] });
  const second = await ensureState({ controlHome: home, serviceNames: ["notionApi"] });

  assert.deepEqual(Object.keys(first.tokens).sort(), Object.keys(second.tokens).sort());
  assert.equal(first.tokens.notionApi, second.tokens.notionApi);
  assert.match(first.tokens.notionApi, /^[a-f0-9]{64}$/);

  const raw = await readFile(path.join(home, "state.json"), "utf8");
  assert.equal(JSON.parse(raw).tokens.notionApi, first.tokens.notionApi);
});
