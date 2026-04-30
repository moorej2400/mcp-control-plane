import { readFile } from "node:fs/promises";

import {
  CODEX_CONFIG,
  buildCleanupPatterns,
  buildServiceSpecs,
  getServiceNames,
  loadServiceDefinitions,
} from "./services.mjs";
import { ensureState } from "./state.mjs";
import { parseCodexEnv } from "./config.mjs";

export async function buildContext({
  codexConfigPath = CODEX_CONFIG,
  controlHome,
  serviceConfigPath,
} = {}) {
  const definitions = await loadServiceDefinitions({ configPath: serviceConfigPath });
  const serviceNames = getServiceNames(definitions);
  const state = await ensureState({ controlHome, serviceNames });
  const codexConfig = await readOptionalFile(codexConfigPath);
  const codexEnv = parseCodexEnv(codexConfig, serviceNames);
  const specs = buildServiceSpecs({ codexEnv, definitions, tokens: state.tokens });
  return { cleanupPatterns: buildCleanupPatterns(definitions), codexConfig, codexEnv, definitions, specs, state };
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
