import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withDirectoryLock } from "./locks.mjs";
import { CONTROL_HOME } from "./services.mjs";

export async function serviceStatus(specs, { controlHome = CONTROL_HOME } = {}) {
  const rows = [];
  for (const spec of Object.values(specs)) {
    if (spec.managed === false) {
      rows.push({
        healthy: null,
        managed: false,
        name: spec.name,
        pid: null,
        running: null,
        url: spec.url,
      });
      continue;
    }
    const pid = await readPid(spec.name, controlHome);
    rows.push({
      healthy: pid ? await checkHealth(spec).then(() => true, () => false) : false,
      name: spec.name,
      pid,
      running: pid ? isProcessAlive(pid) : false,
      url: spec.url,
    });
  }
  return rows;
}

export async function startServices(specs, { controlHome = CONTROL_HOME, quiet = false } = {}) {
  await mkdir(path.join(controlHome, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(controlHome, "pids"), { recursive: true, mode: 0o700 });

  const results = [];
  for (const spec of Object.values(specs)) {
    if (spec.managed === false) {
      results.push({ action: "skip", managed: false, name: spec.name, pid: null });
      continue;
    }
    results.push(await startService(spec, { controlHome, quiet }));
  }
  return results;
}

export async function startService(spec, { controlHome = CONTROL_HOME, quiet = false } = {}) {
  await mkdir(path.join(controlHome, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(controlHome, "pids"), { recursive: true, mode: 0o700 });

  return withDirectoryLock(spec.name, controlHome, async () => {
    const existingPid = await readPid(spec.name, controlHome);
    if (existingPid && isProcessAlive(existingPid)) {
      return { action: "skip", name: spec.name, pid: existingPid };
    }

    const stdout = openSync(path.join(controlHome, "logs", `${spec.name}.out.log`), "a");
    const stderr = openSync(path.join(controlHome, "logs", `${spec.name}.err.log`), "a");
    const [command, ...args] = spec.command;
    let child;
    try {
      child = spawn(command, args, {
        cwd: spec.cwd,
        detached: true,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", stdout, stderr],
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    child.unref();
    await writePid(spec.name, child.pid, controlHome);
    if (!quiet) process.stderr.write(`started ${spec.name} pid=${child.pid}\n`);
    return { action: "start", name: spec.name, pid: child.pid };
  });
}

export async function stopServices(specs, { controlHome = CONTROL_HOME } = {}) {
  const results = [];
  for (const spec of Object.values(specs)) {
    if (spec.managed === false) {
      results.push({ action: "skip", managed: false, name: spec.name, pid: null });
      continue;
    }
    const pid = await readPid(spec.name, controlHome);
    if (!pid || !isProcessAlive(pid)) {
      await removePid(spec.name, controlHome);
      results.push({ action: "skip", name: spec.name, pid });
      continue;
    }
    process.kill(-pid, "SIGTERM");
    results.push({ action: "term", name: spec.name, pid });
    await removePid(spec.name, controlHome);
  }
  return results;
}

export async function healthReport(specs) {
  const results = [];
  for (const spec of Object.values(specs)) {
    if (spec.managed === false) {
      results.push({ name: spec.name, ok: null, url: spec.url });
      continue;
    }
    try {
      await checkHealth(spec);
      results.push({ name: spec.name, ok: true, url: spec.url });
    } catch (error) {
      results.push({ error: error.message, name: spec.name, ok: false, url: spec.url });
    }
  }
  return results;
}

export async function managedRootPids(specs, { controlHome = CONTROL_HOME } = {}) {
  const pids = [];
  for (const spec of Object.values(specs)) {
    if (spec.managed === false) continue;
    const pid = await readPid(spec.name, controlHome);
    if (pid && isProcessAlive(pid)) pids.push(pid);
  }
  return pids;
}

export async function checkHealth(spec, { fetchFn = fetch } = {}) {
  await httpRequest({
    fetchFn,
    headers: spec.codexHeaders,
    method: "POST",
    timeoutMs: 3_000,
    url: spec.url,
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "mcp-control-plane", version: "0.1.0" },
        protocolVersion: "2025-06-18",
      },
    }),
  });
}

export function formatTable(rows) {
  return rows
    .map((row) => Object.entries(row).map(([key, value]) => `${key}=${value}`).join(" "))
    .join("\n");
}

async function httpRequest({ body, headers, method, timeoutMs, url, fetchFn = fetch }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      body,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      method,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readPid(name, controlHome) {
  try {
    return Number(await readFile(pidPath(name, controlHome), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writePid(name, pid, controlHome) {
  await writeFile(pidPath(name, controlHome), `${pid}\n`, { mode: 0o600 });
}

async function removePid(name, controlHome) {
  await rm(pidPath(name, controlHome), { force: true });
}

function pidPath(name, controlHome) {
  return path.join(controlHome, "pids", `${name}.pid`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
