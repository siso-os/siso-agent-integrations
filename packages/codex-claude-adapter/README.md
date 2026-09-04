# codex-claude-adapter — Claude models inside the Codex CLI

State: **opt-in pilot, parked 2026-09-04.** Live on the laptop at `:8084`; Fable end-to-end
unverified since the last rebuild (Haiku verified through the same path). Read `HANDOFF.md`
before touching anything.

## What it is

A loopback Node process that speaks OpenAI Responses (streaming) to the Codex CLI and Anthropic
Messages (streaming) to Bifrost, so `codex --profile fable` runs Claude Fable 5.1 with Codex's
tools, compaction, and ~18k boot. GPT models pass through untouched.

## Mechanism

One Codex turn is one Responses SSE stream. Underneath, the adapter may issue several Anthropic
calls ("segments"):

1. **Retries before content.** 408/429/5xx and connect errors retry with exponential jitter
   (`Retry-After` honoured, up to 6 attempts) while sending SSE keepalive comments so Codex's
   idle timer does not fire.
2. **Live translation.** `content_block_*` events become `reasoning` / `message` /
   `function_call` / `custom_tool_call` / `tool_search_call` items with proper `output_index`.
3. **Continuation.** On `stop_reason=max_tokens` or an upstream drop after content started, the
   adapter appends the replayable blocks (text, signed thinking, complete tool_use) as an assistant
   message plus a marker user message, then streams the next segment into the same Codex response.
   A partial tool call is discarded and the model is asked to re-issue it once. Boundaries are
   recorded inside the `reasoning` item's `encrypted_content` so later turns replay the same shape.
4. **Thinking round-trip.** Thinking blocks with signatures are base64-encoded into `reasoning`
   items; Codex sends them back with `include: ["reasoning.encrypted_content"]`.
5. **Cache breakpoints.** Last tool, last system block, plus top-level automatic caching.

Environment knobs (set in the launchd plist):

| Var | Default | Meaning |
|---|---|---|
| `CODEX_BIFROST_FABLE_ADAPTER` | must be `1` | enables the Claude path |
| `CODEX_BIFROST_CLAUDE_MAX_OUTPUT_TOKENS` | 128000 | per-call ceiling cap (model cap still applies) |
| `CODEX_BIFROST_CLAUDE_MAX_CONTINUATIONS` | 16 | segments per turn before a visible stop note |
| `CODEX_BIFROST_CLAUDE_MAX_ATTEMPTS` | 6 | retries per segment |
| `CODEX_BIFROST_CLAUDE_CACHE_TTL` | unset | `1h` to request the hour cache |
| `CODEX_BIFROST_CLAUDE_KEYCHAIN_ACCOUNT` | `$USER` | Keychain account holding Claude Code OAuth |

Log line per turn (JSON, stdout): `event=claude_adapter_complete` with `segments`,
`continuations`, `attempts`, `response_status`, `stop_reason`, `usage`, `max_tokens`.

## Files

- `codex-bifrost-responses-normalizer.mjs` — the adapter (mirror of `~/bin/...`)
- `codex-fable` — launcher with port preflight
- `profiles/` — Codex profile files, Claude base prompt, launchd plist, Fable catalog entries
- `tests/mock-upstream.mjs` — fault-injecting tee (`pass|429once|529twice|500once|dropmid`) for a normalizer pointed at `:8090`
- `tests/tee-capture.mjs` — request-body capture in front of the adapter
- `evidence/` — adapter logs from the continuation and fault-injection runs, a Codex e2e log, and the investigators' raw findings

## Fault-injection recipe

```bash
S=$(mktemp -d)
node tests/mock-upstream.mjs &                         # :8090 → Bifrost :8080, mode file ./mock-mode
CODEX_BIFROST_NORMALIZER_PORT=8097 CODEX_BIFROST_ANTHROPIC_UPSTREAM=http://127.0.0.1:8090 \
CODEX_BIFROST_FABLE_ADAPTER=1 CODEX_BIFROST_CLAUDE_MAX_OUTPUT_TOKENS=150 \
node codex-bifrost-responses-normalizer.mjs &          # :8097
echo 529twice > mock-mode
curl -N http://127.0.0.1:8097/openai/v1/responses -H 'content-type: application/json' \
  -d '{"model":"CodexProxy/claude-haiku-4-5-20251001","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"20 numbered facts about volcanoes"}]}]}'
```

Expected: `response.completed`, 20 monotonic lines, adapter log shows two `http_529` retries
then `limit` continuations. Kill listeners by PID from `lsof -tiTCP:<port> -sTCP:LISTEN`.

## Safety contract

- Loopback only. Reads the Claude OAuth token from the Keychain per request; never logs it.
- Request and response content never enter the adapter log; only counts and statuses.
- GPT routes are byte-for-byte passthrough except reasoning-event normalisation that predates this package.
- Rollback: copy a `.bak-*` over the live file and `launchctl kickstart -k` the service.
