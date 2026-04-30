# Agent Notes

Read `README.md` first, then `docs/architecture.md` before changing transport behavior. Keep this file concise; put long explanations in `docs/`.

## Local State

- Public remote: `https://github.com/moorej2400/mcp-control-plane`.
- Machine-specific service config lives outside git at `~/.mcp-control-plane/services.json`.
- Runtime state, pids, locks, and logs live under `~/.mcp-control-plane/`.
- Codex config is `~/.codex/config.toml`; `codex-config --apply` creates timestamped `.bak` backups.

## Safety

- Keep secrets, local usernames, tokens, private paths, and private project names out of tracked files.
- Do not commit `.codex/`, `.cloud/`, `mcp-control-plane.config.json`, `services.json`, `.env*`, logs, or backups.
- Do not kill unrelated user processes. Use cleanup dry runs first, and apply only when explicitly requested.
- Before public pushes, scan tracked content for private data with `git grep` or `rg` and inspect git history.

## MCP Transport Rules

- Prefer `stdio` for unknown stdio-only MCPs. It is the compatibility default.
- Use `streamable-http` only when the MCP server natively supports Streamable HTTP and can handle multiple client sessions.
- Use `stdio-proxy` only after testing two simultaneous clients through initialize, tool calls, shutdown, and reconnect.
- Stdio services are intentionally shown as unmanaged in `status`; managed health applies to shared HTTP daemons.
- `inheritEnv` copies selected env vars from existing Codex MCP blocks; do not put secret values in repo examples.

## Verification

- Run `npm test` before claiming config, transport, cleanup, or process behavior works.
- Run `node bin/mcpctl.mjs status` after local config changes.
- Run `node bin/mcpctl.mjs health` when changing shared HTTP daemon behavior.
- Use `node bin/mcpctl.mjs codex-config` to preview config and `node bin/mcpctl.mjs codex-config --apply` to rewrite Codex config.
- If testing process leaks, snapshot processes, launch the Codex TUI, exit only that test TUI, then snapshot again.

## GitHub History

- The public repo was recreated from a sanitized root commit to avoid exposing old local-path history.
- Do not force-push or rewrite public history unless the user explicitly asks.
- If private data ever lands in a commit, remove it from history before making or keeping the repo public.
