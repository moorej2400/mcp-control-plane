# MCP Control-Plane Architecture

This project is intentionally config-driven. A service definition describes what an MCP server can do, and the control plane chooses the least surprising runtime behavior from that definition.

## Service Config Locations

The control plane loads the first config file it finds:

1. `MCP_CONTROL_PLANE_CONFIG`
2. `~/.mcp-control-plane/services.json`
3. `./mcp-control-plane.config.json`

Keep machine-specific paths and tokens out of git. A checked-in repo should usually provide only `examples/services.example.json`.

## Transport Options

### `stdio`

Use this when the MCP server only supports stdio or has not been proven safe under multiple clients.

Behavior:

- Codex starts `mcpctl connect <name>`.
- `mcpctl` starts the configured command as a child process.
- stdout is filtered so non-JSON startup logs do not break the MCP handshake.
- Each AI session gets its own server process.

This is the most compatible mode. It does not solve duplication for that server, but it avoids fake sharing that can corrupt sessions or break initialization.

Good fit:

- stdio-only npm or Python MCP servers
- servers that keep per-client state in process memory
- servers that print startup logs on stdout

Example:

```json
{
  "name": "browser_tools",
  "transport": "stdio",
  "command": ["npx", "-y", "chrome-devtools-mcp@0.23.0"],
  "cleanupPatterns": ["chrome-devtools-mcp"]
}
```

### `streamable-http`

Use this when the MCP server natively supports Streamable HTTP and can handle more than one client session.

Behavior with `command`:

- The first client starts the daemon.
- Later clients reuse the daemon.
- Codex still talks stdio to `mcpctl`, and `mcpctl` bridges each client to the HTTP MCP endpoint.

Behavior without `command`:

- The control plane treats the server as externally managed.
- `mcpctl connect <name>` only bridges to the configured URL.

Good fit:

- local MCP daemons designed for shared use
- remote MCP endpoints
- custom servers with explicit Streamable HTTP session support

Example:

```json
{
  "name": "local_planner",
  "transport": "streamable-http",
  "cwd": "/path/to/local-planner-mcp",
  "command": ["npm", "run", "start:mcp:http"],
  "url": "http://127.0.0.1:49101/mcp"
}
```

### `stdio-proxy`

Use this only after testing. It runs a stdio MCP server behind `mcp-proxy` and exposes an HTTP endpoint.

This can help with some legacy servers, but it is not a universal stdio multiplexer. Many stdio MCP servers assume one client per process, so proxying them can still fail under concurrent clients.

Good fit:

- a stdio server that has been tested with multiple clients through the proxy
- a server whose internal state is read-only or otherwise concurrency-safe

Avoid when:

- initialization fails intermittently
- tools depend on per-client process state
- the upstream server emits unexpected stdout that the proxy cannot tolerate

## Choosing A Transport

Start with these questions:

1. Does the MCP server natively support Streamable HTTP?
   - If yes, use `streamable-http`.
   - If it can run as a daemon, include `command`.
   - If another supervisor already owns it, omit `command`.
2. Is the server stdio-only?
   - Use `stdio` first.
   - Add `cleanupPatterns` so stale duplicates can be found safely.
3. Do you need sharing for a stdio-only server?
   - Try `stdio-proxy` in a test branch.
   - Launch two clients at once and run tools from both.
   - Keep it only if initialize, tool calls, shutdown, and reconnects are stable.

## Config Fields

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Codex MCP server name. |
| `transport` | no | `stdio`, `streamable-http`, or `stdio-proxy`. Defaults to `stdio`. |
| `command` | for `stdio` and `stdio-proxy` | Command array to start the server. Optional for externally managed `streamable-http`. |
| `cwd` | no | Working directory for the command. |
| `env` | no | Literal environment values passed to the wrapper/server. Do not store secrets in checked-in configs. |
| `inheritEnv` | no | Environment variable names copied from the existing Codex MCP config into the wrapper block. |
| `url` | for HTTP transports | MCP HTTP endpoint. |
| `cleanupPatterns` | no | Regex strings used to identify stale process groups during dry-run or cleanup. |
| `stdoutFilter` | no | For stdio services. Defaults to `json-rpc`, which diverts non-JSON stdout to stderr. |

## Real-World Examples

These examples explain the reasoning pattern without requiring any private local paths.

| Server type | Typical mode | Why |
| --- | --- | --- |
| `chrome-devtools-mcp` | `stdio` | It is usually launched as a stdio tool and should be isolated unless you have validated a shared mode. |
| Notion stdio MCP packages | `stdio` | Tokens stay in the local environment, and direct stdio keeps initialization simple. |
| Custom MCP with native Streamable HTTP | `streamable-http` | One daemon can serve multiple AI sessions without creating duplicate Node trees. |
| Remote hosted MCP endpoint | `streamable-http` without `command` | The endpoint is already managed elsewhere. |
| Experimental legacy stdio sharing | `stdio-proxy` | Only appropriate after explicit multi-client testing. |

## Process Cleanup

Cleanup is intentionally conservative:

- it only considers processes matched by configured `cleanupPatterns`
- it keeps the newest duplicate process group
- it can flag orphaned configured MCP process groups whose original AI client already exited
- it samples CPU before applying
- dry run is the default

Codex may start all configured MCP clients at the same time. Control-plane state is protected by a local lock and rewritten through an atomic rename so concurrent wrappers do not read partially written JSON.

Run:

```bash
node bin/mcpctl.mjs cleanup --minimum-age-seconds 600
```

Then add `--apply` only after reviewing the candidates.
