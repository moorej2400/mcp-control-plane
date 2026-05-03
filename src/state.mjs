import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { withDirectoryLock } from "./locks.mjs";
import { CONTROL_HOME } from "./services.mjs";

export async function ensureState({ controlHome = CONTROL_HOME, serviceNames = [] } = {}) {
  await mkdir(controlHome, { recursive: true, mode: 0o700 });
  await mkdir(path.join(controlHome, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(controlHome, "pids"), { recursive: true, mode: 0o700 });

  return withDirectoryLock("state", controlHome, async () => {
    const statePath = path.join(controlHome, "state.json");
    const existing = await readJson(statePath);
    const state = {
      createdAt: existing.createdAt ?? new Date().toISOString(),
      tokens: { ...(existing.tokens ?? {}) },
    };
    let changed = !existing.createdAt;

    for (const name of serviceNames) {
      if (!state.tokens[name]) {
        state.tokens[name] = randomBytes(32).toString("hex");
        changed = true;
      }
    }

    if (changed) await writeJsonAtomic(statePath, state);
    return state;
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  // Codex starts MCP clients in parallel; rename keeps readers from seeing a truncated state file.
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}
