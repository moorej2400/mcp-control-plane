# Shared MCP Proxy Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Codex chats from spawning any MCP process per chat by making the default Codex config contain only shared URL-based MCP endpoints.

**Architecture:** Codex must not launch MCP commands for normal chat startup. The control plane owns daemon lifecycle out-of-band through `mcpctl start` and LaunchAgents, then `codex-config --apply` writes direct `url = ...` MCP blocks for every configured service. Native Streamable HTTP services run as shared daemons; stdio-only services run behind a persistent session-safe shared proxy daemon that intercepts per-client shutdown/exit without terminating the backing server. Disabling a configured MCP is not an acceptable solution; any server that cannot be shared by plain proxy must get a stronger gateway, coordinator, or fixed shared pool.

**Tech Stack:** Node.js 22+ ESM, `node:test`, MCP Streamable HTTP, `mcp-proxy`, Codex `~/.codex/config.toml`, local state under `~/.mcp-control-plane/`.

---

## Current Problem

The live process snapshot showed that `teamwork` and `roundtable-v2` are shared correctly as Streamable HTTP daemons, but `notionApi`, `chrome-devtools`, `macos_automator`, `messages`, `shortcuts-mcp`, and `pac-cli` still run as direct stdio. Each Codex chat starts one `mcpctl connect <name>` wrapper and one backing process tree for every direct stdio service. With several chats open, the multiplication can plausibly reach tens of GB of RSS. The project goal is stricter than sharing only the heavy backing process: default Codex startup must not spawn any MCP wrapper or MCP server process per chat.

The root cause is intentional in the current code:

- `src/services.mjs` maps `transport: "stdio"` to `bridgeTransport: "stdio-direct"` and `managed: false`.
- `src/connect.mjs` routes `stdio-direct` to `runDirectStdio()`, which spawns the configured command for every Codex session.
- `docs/architecture.md` documents that each AI session gets its own server process for stdio.

## Target Runtime Policy

Use three runtime classes:

1. `streamable-http`: one managed or external HTTP MCP endpoint shared across chats; Codex connects by direct URL.
2. `stdio-proxy`: one managed local proxy daemon wrapping a stdio server; Codex connects by direct URL only after validation proves session isolation and shutdown safety.
3. `shared-pool`: a fixed-size shared pool for servers that cannot safely multiplex all clients through one backing process but still must not spawn per chat.

Direct Codex `url` config is the rollout target. Because direct URL bypasses `connectService()` startup/health sequencing and bypasses the current stdio bridge's `handleLocalBridgeMessage()`, the plan must move those responsibilities into always-running daemons before switching config:

- LaunchAgents or `mcpctl start --all` must start shared daemons before Codex opens.
- `mcpctl codex-config --apply` must refuse to emit URL blocks for managed daemons that are not configured for out-of-band startup unless `--force` is passed.
- The stdio proxy daemon must own shutdown/exit interception; one client's shutdown cannot terminate the proxy or backing stdio server for other clients.

Initial service classification:

| Service | Target mode | Reason |
| --- | --- | --- |
| `roundtable-v2` | keep `streamable-http` | Already shared and healthy. |
| `teamwork` | keep `streamable-http` | Already shared and healthy. |
| `notionApi` | promote to `streamable-http` | `@notionhq/notion-mcp-server@2.2.1` supports `--transport http --port`. |
| `shortcuts-mcp` | candidate `stdio-proxy` | Local FastMCP server currently stdio-only; validate before sharing. |
| `messages` | candidate `stdio-proxy` | Likely read-heavy and small; validate before sharing. |
| `macos_automator` | candidate `stdio-proxy` | Automation permissions and side effects need validation. |
| `pac-cli` | required `stdio-proxy` or `shared-pool` | Needs environment/runtime validation before sharing; must not remain direct in default config. |
| `chrome-devtools` | required `stdio-proxy`, gateway, or `shared-pool` | Must stay available in all chats; must not remain direct. If single-process sharing is unsafe, use a coordinator or fixed shared pool. |

## File Map

- Modify `src/services.mjs`: parse shared transport options, build URL-based Codex blocks, build auth headers/env, make `stdio-proxy` managed, and support fixed shared pools.
- Modify `src/config.mjs`: rewrite managed MCP blocks to direct URL blocks for every configured service.
- Modify `src/proxy-daemon.mjs`: create a persistent session-safe proxy/gateway for stdio-only services if `mcp-proxy` alone cannot prove safe shutdown semantics.
- Create `src/shared-pool.mjs`: fixed-size shared process pool for services such as Chrome DevTools when a single backing MCP cannot safely multiplex every client.
- Modify `src/connect.mjs`: keep bridge behavior only for manual diagnostics; normal Codex config must not use it.
- Modify `src/supervisor.mjs`: health-check authenticated HTTP/proxy/pool services, including externally started LaunchAgent services, and report shared status clearly.
- Modify `src/launchagents.mjs`: write and optionally bootstrap LaunchAgents, expose labels, and make lifecycle visible to status/health.
- Create `src/validate.mjs`: two-client MCP validation harness for shared candidates.
- Modify `bin/mcpctl.mjs`: add `validate-shared <service>`, `codex-config --force`, and optional JSON output.
- Modify `docs/architecture.md` and `README.md`: document zero-per-chat startup, direct URL mode, auth, proxy validation, required shared services, fixed shared pools, and service classification.
- Modify tests in `test/services.test.mjs`, `test/config.test.mjs`, `test/connect.test.mjs`, `test/supervisor.test.mjs`, `test/launchagents.test.mjs`, and add `test/validate.test.mjs`, `test/shared-pool.test.mjs`.
- Update local `~/.mcp-control-plane/services.json` only after code supports the new modes; keep secrets and machine paths out of tracked files.

---

### Task 1: Add Shared HTTP Spec Fields

**Files:**
- Modify: `src/services.mjs`
- Test: `test/services.test.mjs`

- [ ] **Step 1: Write failing tests for authenticated shared HTTP specs**

Add a test proving a service can declare generated bearer auth for a managed HTTP daemon:

```js
test("streamable HTTP services can use generated bearer auth", () => {
  const definitions = normalizeServiceDefinitions({
    services: [{
      name: "notionApi",
      transport: "streamable-http",
      command: ["npx", "-y", "@notionhq/notion-mcp-server@2.2.1", "--transport", "http", "--port", "49743"],
      url: "http://127.0.0.1:49743/mcp",
      httpAuth: "bearer-state-token"
    }]
  });
  const specs = buildServiceSpecs({ definitions, tokens: { notionApi: "abc123" } });
  assert.equal(specs.notionApi.managed, true);
  assert.equal(specs.notionApi.bridgeTransport, "streamable-http");
  assert.deepEqual(specs.notionApi.codexHeaders, { Authorization: "Bearer abc123" });
  assert.equal(specs.notionApi.env.AUTH_TOKEN, "abc123");
});
```

Run: `npm test -- test/services.test.mjs`
Expected: FAIL because `httpAuth` is not parsed or applied.

- [ ] **Step 2: Implement `httpAuth` normalization**

In `normalizeServiceDefinitions()`, include:

```js
httpAuth: service.httpAuth ?? null,
```

Validate only supported values:

```js
function assertHttpAuth(value, label) {
  if (value === null || value === undefined) return null;
  if (value === "bearer-state-token") return value;
  throw new Error(`${label} must be "bearer-state-token"`);
}
```

- [ ] **Step 3: Apply auth in `streamable-http` specs**

In `buildServiceSpec()`, when `definition.httpAuth === "bearer-state-token"`:

```js
const token = tokenFor(tokens, definition.name);
const authEnv = { AUTH_TOKEN: token };
const codexHeaders = { Authorization: `Bearer ${token}` };
```

Merge `authEnv` after inherited env only if `AUTH_TOKEN` was not explicitly set. If explicit `AUTH_TOKEN` exists and differs from the state token, throw a clear error to avoid split-brain auth.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/services.test.mjs`
Expected: PASS.

---

### Task 2: Generate URL-Only Codex Config For Enabled Services

**Files:**
- Modify: `src/services.mjs`
- Modify: `src/config.mjs`
- Test: `test/services.test.mjs`
- Test: `test/config.test.mjs`

- [ ] **Step 1: Write failing tests for URL-only config**

Add tests expecting enabled shared services to produce direct URL config:

```toml
[mcp_servers.notionApi]
url = "http://127.0.0.1:49743/mcp"
startup_timeout_sec = 60.0

[mcp_servers.notionApi.headers]
Authorization = "Bearer abc123"
```

Also assert generated config contains no `command = "node"` or `mcpctl connect` block for enabled services in the default profile.

Run: `node --test test/services.test.mjs test/config.test.mjs`
Expected: FAIL because `buildCodexServerBlock()` currently always emits command/args.

- [ ] **Step 2: Make URL blocks mandatory for configured services**

In `buildServiceSpec()`:

```js
codexConnection: "url"
```

Default policy:

- `streamable-http`: `"url"` when healthy startup is configured.
- `stdio-proxy`: `"url"` only after shared validation passes and shutdown safety is provided by the daemon/proxy layer.
- `shared-pool`: `"url"` to the pool coordinator endpoint.
- `stdio`: invalid for generated default config unless paired with a shared proxy/gateway/pool plan.

Do not emit per-chat wrapper command blocks in the normal generated Codex config.

- [ ] **Step 3: Update `buildCodexServerBlock()`**

Branch on `spec.codexConnection`:

```js
if (spec.codexConnection === "url") {
  const lines = [
    `[mcp_servers.${tomlServerName(spec.name)}]`,
    `url = "${escapeToml(spec.url)}"`,
    "startup_timeout_sec = 60.0",
    "",
  ];
  const headers = Object.entries(spec.codexHeaders ?? {});
  if (headers.length > 0) {
    lines.push(`[mcp_servers.${tomlServerName(spec.name)}.headers]`);
    for (const [key, value] of headers) lines.push(`${key} = "${escapeToml(value)}"`);
    lines.push("");
  }
  return lines.join("\n");
}
```

If a configured service cannot produce a URL block, `codex-config --apply` must fail with a clear error that names the service and required migration path. Keep wrapper output available only for a separate diagnostic command such as `mcpctl codex-config --diagnostic-wrapper`, never for the default `--apply` path.

- [ ] **Step 4: Update config rewrite parsing**

Ensure `rewriteCodexConfig()` treats `[mcp_servers.<name>.headers]` like env subblocks for replacement and does not leave stale command/env/header subblocks behind when a service changes from wrapper or stdio to URL mode. Add regression coverage proving a previous direct stdio block is replaced by a URL block, not removed or left active.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/services.test.mjs test/config.test.mjs`
Expected: PASS.

---

### Task 3: Make `stdio-proxy` A Managed Session-Safe URL Daemon

**Files:**
- Modify: `src/services.mjs`
- Modify: `src/supervisor.mjs`
- Create: `src/proxy-daemon.mjs`
- Modify: `src/connect.mjs`
- Test: `test/services.test.mjs`
- Test: `test/supervisor.test.mjs`
- Test: `test/connect.test.mjs`

- [ ] **Step 1: Write failing tests for managed proxy specs**

Update the existing `stdio-proxy` test to assert:

```js
assert.equal(specs.example_proxy.managed, true);
assert.equal(specs.example_proxy.codexConnection, "url");
assert.equal(specs.example_proxy.url, "http://127.0.0.1:49002/mcp");
assert.equal(specs.example_proxy.bridgeUrl, "http://127.0.0.1:49002/sse");
assert.deepEqual(specs.example_proxy.codexHeaders, { "X-API-Key": "proxy-token" });
```

Run: `node --test test/services.test.mjs`
Expected: FAIL because proxy specs currently omit `managed` and URL config intent.

- [ ] **Step 2: Update `proxySpec()`**

Return:

```js
managed: true,
codexConnection: "url",
bridgeTransport: "sse-only",
bridgeUrl: `${target.origin}${sseEndpoint}`,
codexHeaders: { "X-API-Key": token },
url,
```

Keep the existing `mcp-proxy@6.4.6` command construction only if validation proves it is session-safe when Codex connects directly by URL. If it forwards client `shutdown` destructively, replace it with `src/proxy-daemon.mjs`, a persistent local gateway that owns the backing stdio child and handles per-client `shutdown`/`exit` locally.

- [ ] **Step 3: Confirm health uses proxy auth**

`checkHealth()` already spreads `spec.codexHeaders`; add a test that the health POST includes `X-API-Key` for proxy services and `Authorization` for Notion-style services.

- [ ] **Step 4: Move shutdown interception into the shared daemon layer**

Add tests proving direct HTTP/SSE clients can send `shutdown` and `exit` without terminating the shared proxy daemon or backing stdio server. This cannot depend on `connectService()` because normal Codex config no longer uses the per-chat wrapper.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/services.test.mjs test/supervisor.test.mjs test/connect.test.mjs`
Expected: PASS.

---

### Task 4: Add Shared Daemon Lifecycle And Codex Apply Guard

**Files:**
- Modify: `src/services.mjs`
- Modify: `src/supervisor.mjs`
- Modify: `src/launchagents.mjs`
- Modify: `src/config.mjs`
- Modify: `bin/mcpctl.mjs`
- Test: `test/services.test.mjs`
- Test: `test/supervisor.test.mjs`
- Test: `test/launchagents.test.mjs`
- Test: `test/config.test.mjs`

- [ ] **Step 1: Write failing tests for startup ownership**

Add service spec tests for:

- `startup: "managed"`: control plane owns pid file and daemon command.
- `startup: "launchagent"`: control plane owns a LaunchAgent label and can inspect/bootstrap it.
- `startup: "external"`: control plane does not start/stop it but still health-checks the URL before config apply.

Run: `node --test test/services.test.mjs test/supervisor.test.mjs`
Expected: FAIL because specs do not model startup ownership.

- [ ] **Step 2: Implement startup ownership fields**

In normalized service definitions, support:

```json
{
  "startup": "managed",
  "launchAgentLabel": "com.local.mcp-control-plane.notionApi"
}
```

Defaults:

- `streamable-http` with `command`: `startup = "managed"`
- `stdio-proxy` and `shared-pool`: `startup = "managed"`
- remote URL with no command: `startup = "external"`

- [ ] **Step 3: Make status and health URL-first**

Update `serviceStatus()` and `healthReport()` so every URL-backed service is health-checked, including `startup: "external"` and `startup: "launchagent"`. Managed pid state is additional metadata, not the only source of truth.

Expected status fields:

```text
name=notionApi startup=managed codexConnection=url healthy=true running=true url=http://127.0.0.1:49743/mcp
```

- [ ] **Step 4: Add LaunchAgent bootstrap visibility**

Extend `src/launchagents.mjs` so `launchagents --write` can also support:

```bash
node bin/mcpctl.mjs launchagents --write --bootstrap
node bin/mcpctl.mjs launchagents --status
```

Use `launchctl print gui/$UID/<label>` for status and `launchctl bootstrap gui/$UID <plist>` for bootstrap. Tests should mock command execution; do not require LaunchAgent mutation in unit tests.

- [ ] **Step 5: Add `codex-config --apply` readiness guard**

Before writing direct URL blocks, `applyCodexConfig()` must verify every configured service has a URL-backed spec and a healthy endpoint. Add:

```bash
node bin/mcpctl.mjs codex-config --apply
node bin/mcpctl.mjs codex-config --apply --force
```

Default behavior: fail with a clear per-service error if any endpoint is unhealthy or startup ownership is unknown.

`--force`: write config anyway, but include the failed health report in command output.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/services.test.mjs test/supervisor.test.mjs test/launchagents.test.mjs test/config.test.mjs`
Expected: PASS.

---

### Task 5: Add Real Two-Client Shared Validation

**Files:**
- Create: `src/validate.mjs`
- Modify: `bin/mcpctl.mjs`
- Test: `test/validate.test.mjs`

- [ ] **Step 1: Write validation unit and integration tests**

Create fake-fetch unit tests plus a real child-process integration test with a tiny test MCP daemon/proxy. The integration test must prove process survival, not only JSON-RPC response shape.

Test cases:

- initialize succeeds for client A and B with separate MCP session IDs
- client A and B stay initialized concurrently before either client shuts down
- `tools/list` succeeds for both clients while both sessions are active
- optional harmless tool call runs from both clients while both sessions are active
- shutdown from client A does not break client B's next `tools/list`
- shutdown from client B does not kill the shared daemon
- reconnect succeeds after shutdown
- validation fails with a clear reason if client B initialize fails
- after client A shutdown, the proxy daemon PID and backing stdio child PID are unchanged
- after two clients disconnect, no extra backing stdio child was spawned

Run: `node --test test/validate.test.mjs`
Expected: FAIL because `src/validate.mjs` does not exist.

- [ ] **Step 2: Implement `validateSharedService()`**

Expose:

```js
export async function validateSharedService(spec, {
  clients = 2,
  fetchFn = fetch,
  validationTool = null,
  validationArgs = {},
} = {}) {}
```

Behavior:

1. Start managed service with `startService(spec)`, or verify external/LaunchAgent service is healthy.
2. For each client, POST `initialize` to `spec.url`.
3. Capture each `mcp-session-id`.
4. POST `notifications/initialized`.
5. POST `tools/list`.
6. If `validationTool` is set, POST `tools/call`.
7. Re-run `tools/list` for client A after client B has initialized, and for client B after client A has initialized.
8. POST `shutdown` and `notifications/exit` for client A.
9. Confirm client B can still run `tools/list`.
10. POST `shutdown` and `notifications/exit` for client B.
11. Verify process identity/count invariants when the service is locally managed.
12. Repeat initialize/tools/list once for reconnect.

Return structured JSON:

```js
{
  ok: true,
  service: spec.name,
  clients: 2,
  checks: [...],
  processChecks: [...],
  safeForSharedProxy: true
}
```

On failure:

```js
{
  ok: false,
  service: spec.name,
  failedCheck: "clientB.initialize",
  error: "HTTP 500"
}
```

- [ ] **Step 3: Add CLI command**

In `bin/mcpctl.mjs`, add:

```text
validate-shared <service> [--json] [--tool NAME] [--tool-args JSON]
```

Default output should be human-readable; `--json` should print the full result.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/validate.test.mjs`
Expected: PASS.

---

### Task 6: Implement Fixed Shared Pool Fallback

**Files:**
- Create: `src/shared-pool.mjs`
- Modify: `src/services.mjs`
- Modify: `src/supervisor.mjs`
- Modify: `bin/mcpctl.mjs`
- Test: `test/shared-pool.test.mjs`
- Test: `test/services.test.mjs`

- [ ] **Step 1: Write failing tests for shared pool specs**

Add config/spec tests for:

```json
{
  "name": "chrome-devtools",
  "transport": "shared-pool",
  "poolSize": 2,
  "url": "http://127.0.0.1:49761/mcp",
  "command": ["npx", "-y", "chrome-devtools-mcp@0.23.0", "--autoConnect"]
}
```

Expected:

- Codex gets one stable URL endpoint.
- The control plane starts at most `poolSize` backing daemons.
- New Codex chats do not cause new backing daemons.

- [ ] **Step 2: Implement pool coordinator contract**

`src/shared-pool.mjs` should expose one MCP HTTP endpoint and route sessions to a bounded set of backing MCP endpoints or proxy children.

Minimum behavior:

- maintain sticky assignment by MCP session ID
- cap backing processes at `poolSize`
- expose `/mcp` for Codex
- expose internal status with pool occupancy and child PIDs
- never spawn per chat beyond the configured pool cap

- [ ] **Step 3: Make Chrome DevTools fallback concrete**

If `validate-shared chrome-devtools` fails for single-proxy mode, the implementation must switch Chrome to `transport: "shared-pool"` instead of leaving the service unresolved.

Add validation expectations:

```bash
node bin/mcpctl.mjs validate-shared chrome-devtools --json
```

If single proxy fails:

```bash
node bin/mcpctl.mjs validate-shared chrome-devtools --transport shared-pool --json
```

Expected: Chrome remains available through one shared URL endpoint.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/shared-pool.test.mjs test/services.test.mjs test/supervisor.test.mjs`
Expected: PASS.

---

### Task 7: Update Local Service Config In A Controlled Order

**Files:**
- Local only: `~/.mcp-control-plane/services.json`
- Local only: `~/.codex/config.toml`

- [ ] **Step 1: Convert `notionApi` first**

Change `notionApi` to:

```json
{
  "name": "notionApi",
  "transport": "streamable-http",
  "command": ["npx", "-y", "@notionhq/notion-mcp-server@2.2.1", "--transport", "http", "--port", "49743"],
  "url": "http://127.0.0.1:49743/mcp",
  "httpAuth": "bearer-state-token",
  "inheritEnv": ["NOTION_TOKEN", "OPENAPI_MCP_HEADERS"],
  "cleanupPatterns": ["notion-mcp-server", "@notionhq/notion-mcp-server"]
}
```

Run:

```bash
node bin/mcpctl.mjs start
node bin/mcpctl.mjs health
node bin/mcpctl.mjs codex-config --apply
```

Expected:

- `notionApi` shows healthy.
- `~/.codex/config.toml` has a direct `url = "http://127.0.0.1:49743/mcp"` block for Notion.
- `~/.codex/config.toml` contains no active `mcpctl connect notionApi` block.
- New Codex chats do not spawn `notion-mcp-server` per chat.

- [ ] **Step 2: Validate proxy candidates one at a time**

For each candidate service:

```bash
node bin/mcpctl.mjs validate-shared messages --json
node bin/mcpctl.mjs validate-shared shortcuts-mcp --json
node bin/mcpctl.mjs validate-shared macos_automator --json
node bin/mcpctl.mjs validate-shared pac-cli --json
node bin/mcpctl.mjs validate-shared chrome-devtools --json
```

Promote services that pass. Services that fail plain proxy validation must be assigned a stronger gateway/coordinator/shared-pool implementation; they must not be disabled or left direct in generated Codex config.

- [ ] **Step 3: Keep Chrome DevTools available through a shared endpoint**

Do not keep an active direct stdio config. Chrome DevTools must be converted to one of:

```json
{
  "name": "chrome-devtools",
  "transport": "stdio-proxy",
  "url": "http://127.0.0.1:<port>/mcp"
}
```

If single-proxy sharing fails because browser state conflicts, implement a Chrome-specific coordinator or fixed shared pool. Codex still gets one stable URL endpoint, and the coordinator routes requests to a bounded set of backing Chrome DevTools MCP daemons.

---

### Task 8: End-To-End Verification

**Files:**
- No source edits expected.

- [ ] **Step 1: Run test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Verify control-plane status and health**

Run:

```bash
node bin/mcpctl.mjs status
node bin/mcpctl.mjs health
```

Expected:

- Shared services show managed and healthy.
- Every configured service has a healthy shared URL endpoint.

- [ ] **Step 3: Snapshot current process baseline**

Run:

```bash
ps -axo pid,ppid,pgid,rss,args | rg 'codex|mcpctl|notion-mcp-server|mcp-proxy|chrome-devtools|macos-automator|mac-messages|shortcuts-mcp|pac copilot'
```

Record counts by service.

- [ ] **Step 4: Launch two temporary Codex TUI sessions**

Open two fresh Codex TUI sessions long enough for MCP startup, then compare process counts.

Expected:

- `notionApi` has one shared daemon, not one process tree per chat.
- Any promoted `stdio-proxy` service has one proxy process tree, not one backing server per chat.
- No new `mcpctl connect <service>` process appears for any configured MCP when a new Codex chat starts.
- `chrome-devtools` has a shared proxy/gateway/pool endpoint and is available in all new chats.

- [ ] **Step 5: Exercise one shared native HTTP tool and one proxy tool**

In one temporary TUI, call a Notion read/search tool. In another temporary TUI, call one promoted proxy candidate's harmless tool.

Expected:

- Both chats can use the shared service.
- No second backing server process appears for the shared service.

- [ ] **Step 6: Do not cleanup active user chats**

Only use:

```bash
node bin/mcpctl.mjs cleanup --dry-run --json
```

Do not run `--apply` while active user chats are open unless explicitly requested.

---

## Acceptance Criteria

- `npm test` passes.
- `node bin/mcpctl.mjs health` reports healthy shared HTTP/proxy services.
- New Codex chats do not spawn per-chat Notion process trees.
- Validated proxy services have one shared daemon/proxy process tree across multiple new chats.
- New Codex chats do not spawn per-chat `mcpctl connect` wrapper processes for MCP startup.
- Client shutdown in one chat does not stop or corrupt another chat's shared proxy session.
- No configured service is disabled as the solution; unsafe plain proxy candidates are handled with a gateway/coordinator/shared pool.
- `cleanup --dry-run` still detects orphaned duplicates but does not touch active sessions.
- Docs clearly explain when to use `stdio`, `streamable-http`, and `stdio-proxy`.
