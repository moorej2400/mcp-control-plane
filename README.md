# MCP Control Plane

Config-driven local tooling for reliable MCP startup, shared HTTP MCP daemons, and conservative cleanup of stale process trees.

## Why

AI coding apps often start one MCP process tree per session. If old sessions do not exit cleanly, a machine can accumulate duplicate Node, Python, or CLI processes and eventually run out of memory.

MCP Control Plane gives each MCP server an explicit runtime strategy:

- direct stdio for maximum compatibility
- shared Streamable HTTP daemons where the MCP server supports it
- an experimental stdio proxy path for servers that pass multi-client testing
- dry-run-first cleanup for stale duplicate process groups

## Quick Start

```bash
git clone https://github.com/moorej2400/mcp-control-plane.git
cd mcp-control-plane
npm install
npm test
```

Create a local service config:

```bash
mkdir -p ~/.mcp-control-plane
cp examples/services.example.json ~/.mcp-control-plane/services.json
```

Edit `~/.mcp-control-plane/services.json` for your MCP servers, then inspect the generated state:

```bash
node bin/mcpctl.mjs status
node bin/mcpctl.mjs codex-config
```

Apply the Codex config rewrite when it looks right:

```bash
node bin/mcpctl.mjs codex-config --apply
```

The apply command writes a timestamped `.bak` next to `~/.codex/config.toml` before editing.

## Service Config

Minimal stdio service:

```json
{
  "services": [
    {
      "name": "browser_tools",
      "transport": "stdio",
      "command": ["npx", "-y", "chrome-devtools-mcp@0.23.0"],
      "cleanupPatterns": ["chrome-devtools-mcp"]
    }
  ]
}
```

Shared local HTTP daemon:

```json
{
  "services": [
    {
      "name": "local_planner",
      "transport": "streamable-http",
      "cwd": "/path/to/local-planner-mcp",
      "command": ["npm", "run", "start:mcp:http"],
      "url": "http://127.0.0.1:49101/mcp"
    }
  ]
}
```

See [docs/architecture.md](docs/architecture.md) for the full decision guide and config reference.

## Commands

```bash
node bin/mcpctl.mjs status
node bin/mcpctl.mjs health
node bin/mcpctl.mjs start
node bin/mcpctl.mjs stop
node bin/mcpctl.mjs cleanup --minimum-age-seconds 600
node bin/mcpctl.mjs cleanup --apply --minimum-age-seconds 600
node bin/mcpctl.mjs codex-config --apply
node bin/mcpctl.mjs launchagents --write
```

## Safety Model

- Secrets and machine-specific paths belong in `~/.mcp-control-plane/services.json`, environment variables, or your Codex config, not in git.
- Cleanup is a dry run unless `--apply` is passed.
- The cleaner only considers configured `cleanupPatterns`.
- Stdio-only MCP servers are not shared by default because many are single-client by design.

## Development

```bash
npm test
```

The test suite covers config parsing, Codex config rewrites, stdio filtering, HTTP bridging helpers, LaunchAgent generation, process classification, cleanup behavior, and supervisor spawning.
