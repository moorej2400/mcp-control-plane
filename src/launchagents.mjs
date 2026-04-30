import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { renderLaunchAgentPlist } from "./plist.mjs";
import { CONTROL_HOME } from "./services.mjs";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const program = path.join(projectRoot, "bin", "mcpctl.mjs");

export async function writeLaunchAgents({
  launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents"),
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("launchagents are only supported on macOS");
  }

  await mkdir(launchAgentsDir, { recursive: true });
  const controlPath = path.join(launchAgentsDir, "com.mcp-control-plane.control.plist");
  const sweeperPath = path.join(launchAgentsDir, "com.mcp-control-plane.sweeper.plist");

  await writeFile(
    controlPath,
    renderLaunchAgentPlist({
      args: ["start", "--quiet"],
      label: "com.mcp-control-plane.control",
      logDir: path.join(CONTROL_HOME, "logs"),
      program,
    })
  );
  await writeFile(
    sweeperPath,
    renderLaunchAgentPlist({
      args: ["cleanup", "--apply", "--minimum-age-seconds", "600"],
      label: "com.mcp-control-plane.sweeper",
      logDir: path.join(CONTROL_HOME, "logs"),
      program,
      startInterval: 300,
    })
  );

  return { controlPath, sweeperPath };
}
