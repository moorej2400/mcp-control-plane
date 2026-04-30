# Agent Notes

Read `README.md` first, then `docs/architecture.md` before changing transport behavior.

- Keep secrets, local usernames, tokens, and machine-specific paths out of the repo.
- Put local service definitions in `~/.mcp-control-plane/services.json` or an ignored `mcp-control-plane.config.json`.
- Use `npm test` before claiming config, transport, cleanup, or process behavior works.
- Do not kill unrelated user processes. Use cleanup dry runs first, and apply only when explicitly requested.
- Prefer `stdio` for unknown stdio-only MCPs. Use `streamable-http` only when the server natively supports it. Use `stdio-proxy` only after multi-client testing.
- `node bin/mcpctl.mjs codex-config --apply` rewrites Codex config and creates a timestamped backup.
