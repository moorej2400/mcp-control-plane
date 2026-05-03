import { findCleanupCandidates, getProcessRows } from "./processes.mjs";

export async function cleanup({
  activeCpuSeconds = 0.2,
  apply = false,
  cleanupPatterns = [],
  currentRootPids = new Set(),
  getRows = getProcessRows,
  kill = process.kill,
  minimumAgeSeconds = 600,
  sampleMs = 1500,
  sleep = delay,
  termGraceMs = 3000,
} = {}) {
  const readRows = () => getRows({ cleanupPatterns });
  const rows = await readRows();
  const candidates = findCleanupCandidates(rows, { currentRootPids, minimumAgeSeconds });

  if (!apply) return { candidates, killed: [], skipped: [], summary: summarize(candidates) };

  const { idle, skipped } = await filterIdleCandidates(candidates, {
    activeCpuSeconds,
    getRows: readRows,
    sampleMs,
    sleep,
  });
  const killed = [];
  for (const candidate of uniqueProcessGroups(idle)) {
    try {
      kill(-candidate.pgid, "SIGTERM");
      killed.push({ ...candidate, signal: "SIGTERM" });
    } catch (error) {
      killed.push({ ...candidate, error: error.message });
    }
  }

  if (killed.some((entry) => entry.signal === "SIGTERM")) {
    await sleep(termGraceMs);
    const liveRows = await getRows();
    for (const candidate of uniqueProcessGroups(idle)) {
      if (!liveRows.some((row) => row.pgid === candidate.pgid)) continue;
      try {
        kill(-candidate.pgid, "SIGKILL");
        killed.push({ ...candidate, signal: "SIGKILL" });
      } catch (error) {
        killed.push({ ...candidate, error: error.message, signal: "SIGKILL" });
      }
    }
  }

  return { candidates, killed, skipped, summary: summarize(candidates) };
}

export function summarize(candidates) {
  const byType = new Map();
  let rssKb = 0;
  for (const candidate of candidates) {
    rssKb += candidate.rssKb;
    byType.set(candidate.type, (byType.get(candidate.type) ?? 0) + 1);
  }
  return {
    count: candidates.length,
    rssMb: Math.round(rssKb / 1024),
    byType: Object.fromEntries([...byType.entries()].sort()),
  };
}

async function filterIdleCandidates(candidates, { activeCpuSeconds, getRows, sampleMs, sleep }) {
  if (candidates.length === 0) return { idle: [], skipped: [] };

  const before = groupCpuTimes(await getRows());
  await sleep(sampleMs);
  const after = groupCpuTimes(await getRows());

  const idle = [];
  const skipped = [];
  for (const candidate of candidates) {
    const start = before.get(candidate.pgid);
    const end = after.get(candidate.pgid);
    const cpuDeltaSeconds = start == null || end == null ? null : Math.max(0, end - start);
    if (cpuDeltaSeconds != null && cpuDeltaSeconds > activeCpuSeconds) {
      skipped.push({
        ...candidate,
        cpuDeltaSeconds,
        reason: `${candidate.reason}; skipped because process group is active`,
      });
      continue;
    }
    idle.push(candidate);
  }
  return { idle, skipped };
}

function groupCpuTimes(rows) {
  const totals = new Map();
  for (const row of rows) {
    if (row.cpuTimeSeconds == null) continue;
    totals.set(row.pgid, (totals.get(row.pgid) ?? 0) + row.cpuTimeSeconds);
  }
  return totals;
}

function uniqueProcessGroups(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.pgid)) continue;
    seen.add(candidate.pgid);
    unique.push(candidate);
  }
  return unique;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
