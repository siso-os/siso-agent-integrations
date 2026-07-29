# SISO context firewall — shadow stage

This integration is a request-only, loopback-only measurement rail for Claude,
Codex, SISO/Pi, and Bifrost-compatible traffic. The current implementation is
**shadow mode only**:

- buffers a bounded request body for aggregate analysis
- projects the existing SISO tool-result filter's savings
- forwards request entity-body octets and end-to-end authentication/cache headers unchanged
- preserves response entity-body and SSE event octets while streaming
- writes only numeric fields and closed-enum buckets to a private JSONL ledger
- never calls Headroom, changes context, caches responses, or persists prompts

It deliberately rejects WebSocket upgrades. Do not point a WebSocket Codex
profile at this stage.

The ledger distinguishes only an allowlisted `model_bucket` for MiniMax M3 and
GPT-5.6 Sol/Terra/Luna, plus a broader closed `model_family`. Every other model
string becomes `unknown`; the request-supplied model name is never persisted.

## Isolated smoke

```bash
node integrations/context-firewall/smoke-shadow.mjs
```

The smoke covers Anthropic Messages, OpenAI Responses, delayed/chunked SSE
passthrough, authentication forwarding, deep/invalid-JSON fail-open behavior,
request-size bounds, numeric loopback enforcement, metrics permissions, and
sentinel non-disclosure.

With local Bifrost already running, this transient canary compares its direct
health response with the response through an ephemeral shadow firewall. It
does not send a provider request, spend tokens, write metrics, or edit routing:

```bash
node integrations/context-firewall/smoke-bifrost-health.mjs
```

## Manual shadow launch

This does not edit any Claude, Codex, Bifrost, or shell configuration:

```bash
SISO_CONTEXT_FIREWALL_UPSTREAM=http://127.0.0.1:8080 \
  node integrations/context-firewall/context-firewall.mjs
```

Defaults:

- bind: `127.0.0.1:18791`
- mode: `shadow` (the only accepted mode)
- maximum request body: 32 MiB
- upstream idle timeout: 5 minutes
- aggregate ledger: `~/.local/state/siso-context-firewall/metrics.jsonl`
- aggregate ledger cap: 16 MiB plus one rotated `.1` file
- health: `GET /__siso_context_firewall/health`

Optional environment variables:

```text
SISO_CONTEXT_FIREWALL_HOST
SISO_CONTEXT_FIREWALL_PORT
SISO_CONTEXT_FIREWALL_UPSTREAM
SISO_CONTEXT_FIREWALL_MAX_BODY_BYTES
SISO_CONTEXT_FIREWALL_UPSTREAM_TIMEOUT_MS
SISO_CONTEXT_FIREWALL_MAX_METRICS_BYTES
SISO_CONTEXT_FIREWALL_METRICS_PATH
```

Set the metrics path to `off` to disable the ledger. The firewall accepts only
numeric loopback binds (`127.0.0.1` or `::1`) and refuses upstream URLs
containing embedded credentials. An upstream base ending in `/v1` does not
duplicate that prefix when the incoming request already starts with `/v1`.

The transparent contract applies to entity bodies and end-to-end headers, not
raw HTTP framing: Node may normalize header casing, replace `Host` and
`Content-Length`, strip hop-by-hop headers, and reframe chunked transfers.

## Promotion boundary

Shadow evidence must show meaningful projected tool-result savings without a
cache-write, stream, tool-pair, latency, or task-quality regression before a
transform mode is implemented. The later transform stage should send selected
content—not request headers—to a stateless, lossless local compressor and must
fail open to the original bytes on timeout, expansion, or schema mismatch.

Do not stack two wire-level history compressors. Headroom and LeanCTX should be
evaluated as alternative compression rails; LeanCTX read/search/retrieve tools
can be tested separately as a read-only complement.

### 2026-07-24 promotion verdict

The global Claude route remains shadow-only. A hardened Headroom 0.32.0
sidecar passed the isolated Oracle contract and a 20-request/two-session live
MiniMax canary: zero provider errors, 61,100 tokens removed, 97.4% average
compression on eligible losslessly-foldable results, and 36.33 ms p95 local
optimization time against 2,460.32 ms provider p95. A real Codex/Sol Responses
request also passed through the opt-in sidecar.

Headroom was not inserted globally because the MiniMax/Bifrost lane reported
zero cache-read tokens for both direct control and transformed traffic, so the
required cache-regression gate cannot be measured. The sidecar LaunchAgent is
installed but disabled after the canary; `siso-headroom enable` is an explicit
opt-in and `siso-headroom disable` is the rollback.
