# Headroom sidecar — staged, opt-in, not production-routed

This integration places one loopback Headroom process between an explicitly
opted-in agent and its existing upstream. It does **not** replace Bifrost or the
MiniMax caching proxy, run `headroom wrap`, install an MCP server, learn from
session history, or edit any user configuration.

## Safe pilot posture

- loopback bind only (`127.0.0.1:18790`)
- existing MiniMax/go-llm upstream remains `127.0.0.1:8789`
- Headroom local telemetry and update checks disabled
- Headroom license reporter disabled by removing the key from the child process
- stateless mode; Headroom's unavoidable `proxy.log` is redirected to an
  operator-selected temporary runtime directory
- no full-message logging, learning, memory, semantic response cache, rate
  limiter, subscription poll, lifecycle reads, CCR markers, injected retrieval
  tool, tool-search schema injection, tool deduplication, ML model download, or
  lossy fallback
- byte/data-lossless compaction only
- ordinary user messages are never compressed; only eligible tool-result text
  is compacted
- list-form/multi-block tool results pass through unchanged because Headroom
  0.32.0 otherwise flattens their block boundaries and metadata
- Headroom cache mode deterministically consolidates message-level
  `cache_control` onto the final content block (system/tool cache controls stay
  exact); the Oracle contract tests this single allowed structural change
- a version-pinned, fail-closed SISO entrypoint preserves client tool order and
  JSON-Schema annotations; Headroom 0.32.0 otherwise changes both even in
  lossless mode

## Use the wired harness for new launches

The canonical launcher is projected to `~/bin/siso-headroom`. On macOS it owns
the private `com.siso.headroom.lossless` LaunchAgent and verifies delayed
readiness; it never restarts or edits an existing Codex, MiniMax, Bifrost, or
go-llm process.

```bash
siso-headroom enable
siso-headroom status
```

Launch one new MiniMax worker through the sidecar without changing
`~/bin/claude-mini`:

```bash
siso-headroom minimax -p 'RETURN: one line. STOP: after answer.'
```

Launch one new Codex invocation with ephemeral provider overrides:

```bash
siso-headroom codex exec --ephemeral 'Return OK only.'
```

Disable only the sidecar process whose pid this harness owns:

```bash
siso-headroom disable
```

The Oracle proof uses a local fake provider and forwards Oracle-derived tool
results in both MiniMax/Anthropic Messages and Codex/OpenAI Responses formats
through the real Headroom proxy. It checks routing, auth forwarding,
system-prompt preservation, exact tool-schema counts/order, cache markers,
tool-call/result pairing, measurable compaction in both lanes, and absence of
request content in the redirected runtime log:

```bash
HEADROOM_BIN=/path/to/venv/bin/headroom \
  node integrations/headroom/smoke-oracle-sidecar.mjs
```

After the isolated proof passes, the live promotion gate runs 20 transformed
and 20 direct-control requests across two MiniMax sessions. It emits aggregate
usage/cache/latency numbers only and rejects provider errors, missing
compression, or request content in the sidecar runtime:

```bash
node integrations/headroom/smoke-live-canary.mjs
```

## Optional persistent Codex route

Persist the already-tested Headroom provider selection in
`~/.codex/config.toml` (the pilot passes the same values through `codex -c`, so
this is a routing persistence change, not a new behavior):

```toml
model_provider = "headroom"

[model_providers.headroom]
name = "Headroom loopback"
base_url = "http://127.0.0.1:18790/v1"
requires_openai_auth = true
supports_websockets = false
```

The Oracle contract, 20-request MiniMax live canary, and one real Codex/Sol
Responses request pass. The harness deliberately leaves the persistent route
unset because the MiniMax provider emits no cache-read counter in either the
direct-control or transformed lane, making a cache regression impossible to
exclude. Explicit `siso-headroom codex` and `siso-headroom minimax` launches are
available after `siso-headroom enable`; rollback is `siso-headroom disable`.
All existing upstream launchers remain unchanged.
