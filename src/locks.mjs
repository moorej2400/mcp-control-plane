import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export async function withDirectoryLock(name, controlHome, callback, { timeoutMs = 30_000 } = {}) {
  const locksDir = path.join(controlHome, "locks");
  const lockPath = path.join(locksDir, `${name}.lock`);
  await mkdir(locksDir, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${name} lock`);
      await delay(100);
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
