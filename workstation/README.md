# SISO Workstation MCP

**Goal:** give ChatGPT Web a private local execution layer for this Mac with no extra UI and no additional AI model in the loop.

ChatGPT invokes MCP tools from this server, and the tools execute directly on the host macOS user context using normal shell/CLI permissions.

## What this plugin exposes

The exposed tool surface is intentionally small:

- `shell_exec(command, cwd?, timeout_ms?)`
- `start_process(command, cwd?)`
- `process_input(session_id, input, newline?)`
- `process_output(session_id)`
- `kill_process(session_id, signal?)`
- `read_file(path, offset?, length?, cwd?)`
- `write_file(path, content, mode?, cwd?)`
- `edit_file(path, old_text, new_text, expected_replacements?, cwd?)`
- `list_directory(path, depth?, cwd?)`
- `search_files(path, query, use_fallback?, cwd?)`
- `computer_status()`

There is **no browser clone** and no custom frontend.

## Local stack

- Project: `apps/codex-remote`
- MCP server script: `server.mjs`
- Manifests:
  - `.mcp.json`
  - `.app.json`
  - `.codex-plugin/plugin.json`

## Install dependencies

```bash
cd $HOME/SISO_Workspace/SISO_Agency/apps/codex-remote
npm install
```

## Start locally (stdio mode)

```bash
cd $HOME/SISO_Workspace/SISO_Agency/apps/codex-remote
./run-codex-remote.sh
```

Environment values used by default:

- `SISO_WORKSTATION_DEFAULT_ROOT` (default `HOME`)
- `SISO_WORKSTATION_DEFAULT_CWD` (default `<workspace>/SISO_Workspace` when found)
- `SISO_WORKSTATION_TIMEOUT_MS` (default `120000`)

## ChatGPT plugin name and install target

Plugin manifest exposes **SISO Workstation**.

- `.codex-plugin/plugin.json[name]`: `siso-workstation`
- `.mcp.json[mcpServers]`: `siso-workstation`
- `.app.json[apps]`: `siso-workstation`

## Local MCP over Secure MCP Tunnel (recommended)

`Secure MCP Tunnel` is the private path for ChatGPT Web without exposing an unauthenticated public port.

Example setup pattern:

```bash
cd $HOME/SISO_Workspace/SISO_Agency/apps/codex-remote
npm install -g @openai/tunnel-client

export CONTROL_PLANE_API_KEY=<YOUR_OPENAI_CONTROL_PLANE_KEY>
export CONTROL_PLANE_TUNNEL_ID=<YOUR_TUNNEL_ID>

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile siso-workstation \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-command "node $HOME/SISO_Workspace/SISO_Agency/apps/codex-remote/server.mjs"

tunnel-client run --profile siso-workstation
```

Use `tunnel-client doctor --profile siso-workstation` and `tunnel-client doctor --profile siso-workstation --explain` before you rely on it.

If OpenAI Secure MCP Tunnel or a matching ChatGPT connector mode is unavailable in your workspace, keep this server in local-only mode and use it where available.

## ChatGPT install + usage flow

1. Install the local plugin bundle that contains the above `plugin.json`/`app.json`/`mcp.json` metadata.
2. Start MCP locally via `./run-codex-remote.sh` or via `tunnel-client run --profile siso-workstation`.
3. In ChatGPT, run the connector with `@SISO Workstation` and invoke tools directly.

Example request text:

- `@SISO Workstation go into Oracle, read CLAUDE.md, inspect branch, fix issue, run tests, show diff`

The model resolves this as calls to:

- `read_file`
- `shell_exec`
- `edit_file`
- `shell_exec` (`pnpm test`)
- `shell_exec` (`git diff`)
- etc.

## Verification checklist (requested)

From this directory:

```bash
node .tmp-smoke.mjs
```

It exercises:

- tool discovery
- `read_file`
- `write_file` + cleanup
- `shell_exec` (`pwd`, `git status`, `gh auth status`, `node`, `python`)
- `search_files`
- `start_process` + `process_output`
- `computer_status`

## Notes

- `edit_file` expects exact text replacement and verifies replacement count.
- `read_file` returns UTF-8 text slices.
- Commands run under your normal macOS user context with the configured shell/user permissions.
- There is no internal `Codex` execution path in this variant.
