import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
export const CONTROL_HOME = path.join(os.homedir(), ".mcp-control-plane");
export const CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
export const MCPCTL = path.join(PROJECT_ROOT, "bin", "mcpctl.mjs");
export const USER_SERVICE_CONFIG = path.join(CONTROL_HOME, "services.json");
export const PROJECT_SERVICE_CONFIG = path.join(PROJECT_ROOT, "mcp-control-plane.config.json");

export async function loadServiceDefinitions({
  configPath,
  env = process.env,
  readFileFn = readFile,
} = {}) {
  const resolvedPath = configPath ?? await findServiceConfigPath({ env });
  if (!resolvedPath) {
    throw new Error(
      `No MCP control-plane config found. Create ${USER_SERVICE_CONFIG} or set MCP_CONTROL_PLANE_CONFIG.`
    );
  }

  const raw = await readFileFn(resolvedPath, "utf8");
  return normalizeServiceDefinitions(JSON.parse(raw), { configPath: resolvedPath });
}

export async function findServiceConfigPath({ env = process.env } = {}) {
  const candidates = [
    env.MCP_CONTROL_PLANE_CONFIG,
    USER_SERVICE_CONFIG,
    PROJECT_SERVICE_CONFIG,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

export function normalizeServiceDefinitions(config, { configPath = "<inline>" } = {}) {
  const services = Array.isArray(config.services)
    ? config.services
    : Object.entries(config.services ?? {}).map(([name, definition]) => ({ name, ...definition }));

  if (!Array.isArray(services) || services.length === 0) {
    throw new Error(`${configPath} must define at least one service`);
  }

  const seen = new Set();
  return services.map((service, index) => {
    const name = assertString(service.name, `${configPath} services[${index}].name`);
    if (seen.has(name)) throw new Error(`${configPath} defines duplicate service ${name}`);
    seen.add(name);

    return {
      cleanupPatterns: assertRegexArray(service.cleanupPatterns ?? [], `${name}.cleanupPatterns`),
      command: service.command === undefined ? undefined : assertStringArray(service.command, `${name}.command`),
      cwd: service.cwd === undefined ? undefined : assertString(service.cwd, `${name}.cwd`),
      env: assertStringMap(service.env ?? {}, `${name}.env`),
      inheritEnv: assertStringArray(service.inheritEnv ?? [], `${name}.inheritEnv`),
      name,
      stdoutFilter: service.stdoutFilter ?? "json-rpc",
      transport: service.transport ?? "stdio",
      url: service.url,
    };
  });
}

export function getServiceNames(definitions) {
  return definitions.map((definition) => definition.name);
}

export function buildServiceSpecs({ codexEnv = {}, definitions, tokens = {} } = {}) {
  if (!definitions) throw new Error("buildServiceSpecs requires service definitions");
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      buildServiceSpec(definition, { codexEnv: codexEnv[definition.name] ?? {}, tokens }),
    ])
  );
}

export function buildCleanupPatterns(definitions) {
  return definitions.flatMap((definition) =>
    definition.cleanupPatterns.map((pattern) => ({
      name: definition.name,
      pattern: new RegExp(pattern),
    }))
  );
}

export function buildCodexServerBlock(spec) {
  const lines = [
    `[mcp_servers.${tomlServerName(spec.name)}]`,
    `command = "node"`,
    `args = ["${escapeToml(MCPCTL)}", "connect", "${escapeToml(spec.name)}"]`,
    "startup_timeout_sec = 60.0",
    "",
  ];

  const envEntries = Object.entries(spec.env ?? {});
  if (envEntries.length > 0) {
    lines.push(`[mcp_servers.${tomlServerName(spec.name)}.env]`);
    for (const [key, value] of envEntries) {
      lines.push(`${key} = "${escapeToml(value)}"`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildServiceSpec(definition, { codexEnv, tokens }) {
  const env = {
    ...definition.env,
    ...pickEnv(codexEnv, definition.inheritEnv),
  };

  switch (definition.transport) {
    case "stdio":
      return {
        bridgeTransport: "stdio-direct",
        command: assertCommand(definition),
        cwd: definition.cwd,
        env,
        managed: false,
        name: definition.name,
        stdoutFilter: definition.stdoutFilter,
        url: null,
      };
    case "streamable-http":
      return {
        bridgeTransport: "streamable-http",
        command: definition.command ? assertCommand(definition) : null,
        cwd: definition.cwd,
        env,
        managed: Boolean(definition.command),
        name: definition.name,
        url: assertString(definition.url, `${definition.name}.url`),
      };
    case "stdio-proxy":
      return proxySpec({
        command: assertCommand(definition),
        cwd: definition.cwd,
        env,
        name: definition.name,
        token: tokenFor(tokens, definition.name),
        url: assertString(definition.url, `${definition.name}.url`),
      });
    default:
      throw new Error(`Unsupported transport "${definition.transport}" for ${definition.name}`);
  }
}

function proxySpec({ command, cwd, env = {}, name, token, url }) {
  const target = new URL(url);
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const streamEndpoint = target.pathname || "/mcp";
  const sseEndpoint = "/sse";

  return {
    bridgeTransport: "sse-only",
    bridgeUrl: `${target.origin}${sseEndpoint}`,
    codexHeaders: { "X-API-Key": token },
    command: [
      "bash",
      "-lc",
      [
        cwd ? `cd ${shellWord(cwd)} &&` : "",
        "exec",
        "npx",
        "-y",
        "mcp-proxy@6.4.6",
        "--host",
        shellWord(target.hostname),
        "--port",
        shellWord(port),
        "--streamEndpoint",
        shellWord(streamEndpoint),
        "--sseEndpoint",
        shellWord(sseEndpoint),
        "--apiKey",
        shellWord(token),
        "--",
        ...command.map(shellWord),
      ].filter(Boolean).join(" "),
    ],
    env,
    name,
    url,
  };
}

function assertCommand(definition) {
  if (!Array.isArray(definition.command) || definition.command.length === 0) {
    throw new Error(`${definition.name}.command must be a non-empty string array`);
  }
  return definition.command.map(String);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function assertRegexArray(value, label) {
  const patterns = assertStringArray(value, label);
  for (const pattern of patterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`${label} contains invalid regex "${pattern}": ${error.message}`);
    }
  }
  return patterns;
}

function assertStringMap(value, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object with string values`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${label} contains invalid environment key "${key}"`);
    }
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
  }
  return value;
}

function pickEnv(source = {}, keys) {
  return Object.fromEntries(keys.filter((key) => source[key]).map((key) => [key, source[key]]));
}

function shellWord(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function tokenFor(tokens, name) {
  if (!tokens[name]) {
    throw new Error(`${name} requires a persisted token before building a stdio-proxy spec`);
  }
  return tokens[name];
}

function tomlServerName(name) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `"${escapeToml(name)}"`;
}

function escapeToml(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
