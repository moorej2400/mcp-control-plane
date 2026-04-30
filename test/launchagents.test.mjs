import assert from "node:assert/strict";
import { test } from "node:test";

import { writeLaunchAgents } from "../src/launchagents.mjs";

test("writeLaunchAgents rejects non-macOS platforms", async () => {
  await assert.rejects(
    () => writeLaunchAgents({ platform: "linux" }),
    /only supported on macOS/
  );
});
