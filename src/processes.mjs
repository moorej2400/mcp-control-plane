import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getProcessRows({ cleanupPatterns = [] } = {}) {
  const { stdout } = await execFileAsync("ps", [
    "-axo",
    "pid=,ppid=,pgid=,etime=,stat=,rss=,pcpu=,time=,command=",
  ]);
  return parsePsRows(stdout, { cleanupPatterns });
}

export function classifyProcess(command, cleanupPatterns = []) {
  for (const { name, pattern } of cleanupPatterns) {
    if (pattern.test(command)) return name;
  }
  return null;
}

export function parsePsRows(text, { cleanupPatterns = [] } = {}) {
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("PID ")) continue;
    const match = line.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+([0-9.]+)\s+(\S+))?\s+(.+)$/
    );
    if (!match) continue;
    rows.push({
      ageSeconds: parseElapsed(match[4]),
      command: match[9],
      cpuPct: match[7] ? Number(match[7]) : null,
      cpuTimeSeconds: match[8] ? parseCpuTime(match[8]) : null,
      pgid: Number(match[3]),
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[6]),
      stat: match[5],
      type: classifyProcess(match[9], cleanupPatterns),
    });
  }
  return rows;
}

export function findCleanupCandidates(
  rows,
  { currentRootPids = new Set(), minimumAgeSeconds = 3600 } = {}
) {
  const roots = findAiRoots(rows);
  const byRootAndType = new Map();

  for (const row of rows) {
    if (!row.type) continue;
    const root = findRootPid(row, rows, roots);
    if (!root || currentRootPids.has(root)) continue;
    if (row.ppid !== root) continue;
    const key = `${root}:${row.type}`;
    if (!byRootAndType.has(key)) byRootAndType.set(key, []);
    byRootAndType.get(key).push(row);
  }

  const candidates = [];
  for (const [key, group] of byRootAndType) {
    if (group.length < 2) continue;
    const [root, type] = key.split(":");
    const newest = group.toSorted((a, b) => a.ageSeconds - b.ageSeconds)[0];
    for (const row of group) {
      if (row.pid === newest.pid) continue;
      if (row.ageSeconds < minimumAgeSeconds) continue;
      candidates.push({
        pid: row.pid,
        pgid: row.pgid,
        reason: `older duplicate ${type} under root ${root}`,
        rssKb: row.rssKb,
        type,
      });
    }
  }

  for (const row of rows) {
    if (row.ppid !== 1 || row.pgid !== row.pid) continue;
    if (currentRootPids.has(row.pid)) continue;
    // Orphaned wrappers often have a generic `mcpctl connect` command;
    // classify them by the MCP child they still own.
    const type = orphanedProcessGroupType(row, rows);
    if (!type) continue;
    if (row.ageSeconds < minimumAgeSeconds) continue;
    const rssKb = rows
      .filter((candidate) => candidate.pgid === row.pgid)
      .reduce((total, candidate) => total + candidate.rssKb, 0);
    candidates.push({
      pid: row.pid,
      pgid: row.pgid,
      reason: `orphaned ${type} process group`,
      rssKb,
      type,
    });
  }

  return candidates.toSorted((a, b) => a.pid - b.pid);
}

function orphanedProcessGroupType(root, rows) {
  if (root.type) return root.type;
  const childTypes = rows
    .filter((row) => row.pgid === root.pgid && row.type)
    .map((row) => row.type);
  return childTypes[0] ?? null;
}

function findAiRoots(rows) {
  const roots = new Set();
  for (const row of rows) {
    if (
      /Codex\.app\/Contents\/Resources\/codex app-server/.test(row.command) ||
      /node .*\/bin\/codex(?:\s|$)/.test(row.command) ||
      /^claude(?:\s|$)/.test(row.command)
    ) {
      roots.add(row.pid);
    }
  }
  return roots;
}

function findRootPid(row, rows, roots) {
  const byPid = new Map(rows.map((candidate) => [candidate.pid, candidate]));
  let current = row;
  const seen = new Set();
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (roots.has(current.pid)) return current.pid;
    current = byPid.get(current.ppid);
  }
  return null;
}

function parseElapsed(value) {
  const dayMatch = value.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    return (
      Number(dayMatch[1]) * 86400 +
      Number(dayMatch[2]) * 3600 +
      Number(dayMatch[3]) * 60 +
      Number(dayMatch[4])
    );
  }
  const parts = value.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) || 0;
}

function parseCpuTime(value) {
  const dayMatch = value.match(/^(\d+)-(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (dayMatch) {
    return (
      Number(dayMatch[1]) * 86400 +
      Number(dayMatch[2]) * 3600 +
      Number(dayMatch[3]) * 60 +
      Number(dayMatch[4])
    );
  }
  const parts = value.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) || 0;
}
