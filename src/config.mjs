import { readFile, rename, writeFile } from "node:fs/promises";

import { CODEX_CONFIG, buildCodexServerBlock } from "./services.mjs";

export async function previewCodexConfig({ configPath = CODEX_CONFIG, readFileFn = readFile, specs }) {
  const original = await readFileFn(configPath, "utf8");
  return rewriteCodexConfig(original, specs);
}

export async function applyCodexConfig({ configPath = CODEX_CONFIG, specs }) {
  const original = await readFile(configPath, "utf8");
  const backupPath = `${configPath}.mcp-control-plane.${timestamp()}.bak`;
  await writeFile(backupPath, original, { mode: 0o600 });
  const next = rewriteCodexConfig(original, specs);
  await writeFile(`${configPath}.tmp`, next, { mode: 0o600 });
  await rename(`${configPath}.tmp`, configPath);
  return { backupPath, configPath };
}

export function rewriteCodexConfig(source, specs) {
  const specMap = new Map(Object.entries(specs));
  const output = [];
  const lines = source.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const section = parseMcpSection(lines[index]);
    if (section && specMap.has(section.name)) {
      output.push(buildCodexServerBlock(specMap.get(section.name)).trimEnd());
      index += 1;
      while (index < lines.length && !isTopLevelSection(lines[index])) {
        index += 1;
      }
      while (index < lines.length) {
        const nested = parseMcpSection(lines[index]);
        if (!nested || nested.name !== section.name) break;
        index += 1;
        while (index < lines.length && !isTopLevelSection(lines[index])) {
          index += 1;
        }
      }
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }

  for (const [name, spec] of specMap) {
    if (!hasMcpSection(source, name)) {
      if (output.at(-1) !== "") output.push("");
      output.push(buildCodexServerBlock(spec).trimEnd());
    }
  }

  return normalizeBlankLines(output.join("\n"));
}

export function parseMcpEnv(source, name) {
  const lines = source.split(/\r?\n/);
  const env = {};
  const envHeader = new RegExp(`^\\[mcp_servers\\.${escapeSectionName(name)}\\.env\\]$`);
  const quotedEnvHeader = new RegExp(`^\\[mcp_servers\\."${escapeRegExp(name)}"\\.env\\]$`);
  let inBlock = false;
  for (const line of lines) {
    if (inBlock && isTopLevelSection(line)) break;
    if (envHeader.test(line.trim()) || quotedEnvHeader.test(line.trim())) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\"|[^"])*)"\s*$/);
    if (match) env[match[1]] = match[2].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return env;
}

export function parseCodexEnv(source, names) {
  return Object.fromEntries(names.map((name) => [name, parseMcpEnv(source, name)]));
}

function parseMcpSection(line) {
  const trimmed = line.trim();
  const quoted = trimmed.match(/^\[mcp_servers\."([^"]+)"(?:\..*)?\]$/);
  if (quoted) return { name: quoted[1] };
  const plain = trimmed.match(/^\[mcp_servers\.([A-Za-z0-9_-]+)(?:\..*)?\]$/);
  if (plain) return { name: plain[1] };
  return null;
}

function hasMcpSection(source, name) {
  return source.split(/\r?\n/).some((line) => parseMcpSection(line)?.name === name);
}

function isTopLevelSection(line) {
  return /^\s*\[[^\]]+\]\s*$/.test(line);
}

function normalizeBlankLines(text) {
  return `${text.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function escapeSectionName(name) {
  return escapeRegExp(name).replaceAll("-", "\\-");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
