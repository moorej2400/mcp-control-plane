#!/usr/bin/env node
import { applyCodexConfig, previewCodexConfig } from "../src/config.mjs";
import { connectService } from "../src/connect.mjs";
import { cleanup } from "../src/cleanup.mjs";
import { buildContext } from "../src/context.mjs";
import { writeLaunchAgents } from "../src/launchagents.mjs";
import {
  formatTable,
  healthReport,
  serviceStatus,
  startServices,
  stopServices,
} from "../src/supervisor.mjs";

const [command, ...args] = process.argv.slice(2);

try {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    process.exit(0);
  }

  const context = await buildContext();
  switch (command) {
    case "status": {
      console.log(formatTable(await serviceStatus(context.specs)));
      break;
    }
    case "start": {
      const quiet = args.includes("--quiet");
      console.log(formatTable(await startServices(context.specs, { quiet })));
      break;
    }
    case "stop": {
      console.log(formatTable(await stopServices(context.specs)));
      break;
    }
    case "health": {
      console.log(formatTable(await healthReport(context.specs)));
      break;
    }
    case "connect": {
      const name = args[0];
      if (!name) {
        console.error("connect requires a service name");
        process.exitCode = 2;
        break;
      }
      process.exitCode = await connectService(context.specs, name);
      break;
    }
    case "cleanup": {
      const apply = args.includes("--apply");
      const json = args.includes("--json");
      const minimumAgeSeconds = numberArg(args, "--minimum-age-seconds", 600);
      const result = await cleanup({
        activeCpuSeconds: numberArg(args, "--active-cpu-seconds", 0.2),
        apply,
        cleanupPatterns: context.cleanupPatterns,
        minimumAgeSeconds,
        sampleMs: numberArg(args, "--sample-ms", 1500),
        termGraceMs: numberArg(args, "--term-grace-ms", 3000),
      });
      console.log(json ? JSON.stringify(result, null, 2) : formatCleanup(result, { apply }));
      break;
    }
    case "codex-config": {
      if (!args.includes("--apply")) {
        process.stdout.write(await previewCodexConfig({ specs: context.specs }));
        break;
      }
      console.log(JSON.stringify(await applyCodexConfig({ specs: context.specs }), null, 2));
      break;
    }
    case "launchagents": {
      if (!args.includes("--write")) {
        console.error("launchagents requires --write");
        process.exitCode = 2;
        break;
      }
      console.log(JSON.stringify(await writeLaunchAgents(), null, 2));
      break;
    }
    default:
      printHelp();
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

function numberArg(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return Number(args[index + 1] ?? fallback);
}

function formatCleanup(result, { apply }) {
  const lines = [
    `candidates=${result.summary.count} rssMb=${result.summary.rssMb} apply=${apply}`,
  ];
  for (const [type, count] of Object.entries(result.summary.byType)) {
    lines.push(`type=${type} candidates=${count}`);
  }
  if (result.skipped.length > 0) lines.push(`skipped=${result.skipped.length}`);
  for (const entry of result.killed) {
    lines.push(
      entry.error
        ? `pgid=${entry.pgid} type=${entry.type} signal=${entry.signal ?? "none"} error=${entry.error}`
        : `pgid=${entry.pgid} type=${entry.type} signal=${entry.signal}`
    );
  }
  if (!apply && result.candidates.length > 0) {
    lines.push("rerun with --json for candidate details; rerun with --apply to terminate idle duplicates");
  }
  return lines.join("\n");
}

function printHelp() {
  console.log(`mcpctl commands:
  status
  connect <service>
  start [--quiet]
  stop
  health
  cleanup [--apply] [--json] [--minimum-age-seconds N] [--sample-ms N]
  codex-config [--apply]
  launchagents --write`);
}
