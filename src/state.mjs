import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CONTROL_HOME } from "./services.mjs";

export async function ensureState({ controlHome = CONTROL_HOME, serviceNames = [] } = {}) {
  await mkdir(controlHome, { recursive: true, mode: 0o700 });
  await mkdir(path.join(controlHome, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(controlHome, "pids"), { recursive: true, mode: 0o700 });

  const statePath = path.join(controlHome, "state.json");
  const existing = await readJson(statePath);
  const state = {
    createdAt: existing.createdAt ?? new Date().toISOString(),
    tokens: { ...(existing.tokens ?? {}) },
  };

  for (const name of serviceNames) {
    if (!state.tokens[name]) state.tokens[name] = randomBytes(32).toString("hex");
  }

  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
