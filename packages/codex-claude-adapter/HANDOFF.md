# Claude-in-Codex adapter — handoff for the next agent

Written 2026-09-04 by the Claude Code session that rebuilt the adapter. Everything marked
VERIFIED was observed in that session; everything marked UNVERIFIED was not. Read this file
first, then `README.md` for the mechanism, then the evidence files only as needed.

## 0. Why this exists and where Shaan left it

Shaan wants Claude models (Fable 5.1 first) hosted inside the Codex CLI because Codex boots in
~18k tokens versus ~40-52k for Claude Code and has native auto-compaction. His first-principles
call: this is one of the highest-ROI infrastructure pieces he has, but he is now back on metered
usage and has parked it. Pick it up when compute is available. Do not spawn agent fleets on it.

Standing decisions (do not relitigate):
- No output cap. The adapter must never end a turn because of a token ceiling. VERIFIED design below.
- Fable stays `[500k]` in the model selector; the `[1m]` alias exists but is untested.
- Claude model IDs route to Anthropic through Bifrost; GPT IDs to Codex. MiniMax is disabled.
- Long-running/background Fable agents go through `codex-fable`; interactive first-mate work stays in Claude Code.

## 1. Where the live pieces are (laptop)

| Piece | Live path | Copy in this package |
|---|---|---|
| Adapter (Responses ⇄ Anthropic Messages) | `~/bin/codex-bifrost-responses-normalizer.mjs` | `codex-bifrost-responses-normalizer.mjs` |
| launchd service (:8084, Fable adapter on) | `~/Library/LaunchAgents/com.siso.codex-bifrost-selector-normalizer.plist` | `profiles/` |
| Codex profiles | `~/.codex/fable.config.toml`, `~/.codex/fable-max.config.toml` | `profiles/` |
| Claude base prompt (replaces Codex's GPT-5 prompt) | `~/.codex/claude-fable-instructions.md` | `profiles/` |
| Launcher with port preflight | `~/bin/codex-fable [--max]` | `codex-fable` |
| Model catalog Codex reads | `~/.codex/bifrost_catalog.json` (`model_catalog_json` in `~/.codex/config.toml`) | `profiles/bifrost_catalog.fable-entries.json` (Fable entries only) |
| Upstream gateway | Bifrost `:8080`, logs in `~/.config/bifrost/logs.db` table `logs` (UTC) | not copied |
| Adapter log | `~/.codex/codex-bifrost-selector-normalizer.out` (JSON lines) | samples in `evidence/` |
| Backups of the adapter | `~/bin/codex-bifrost-responses-normalizer.mjs.bak-pre-stream-20260904T030712` (original), `.bak-pre-engine-*` (first streaming patch) | not copied |

The live files are the source of truth. This package is a checkpoint mirror; if they diverge,
diff before trusting either. Profiles keep absolute laptop paths on purpose because Codex
needs them; the repo AGENTS.md rule against absolute paths is knowingly bent here.

Chain: `codex --profile fable` → `http://127.0.0.1:8084/openai/v1/responses` (adapter) →
`http://127.0.0.1:8080/anthropic/v1/messages` (Bifrost) → Anthropic, using the Claude Code OAuth
token read from the macOS Keychain item `Claude Code-credentials`.

## 2. What was wrong and what is fixed (VERIFIED unless marked)

Symptom Shaan hit: a Fable turn ran 8 minutes over 22 tool calls, then ended with no message.
Bifrost showed the final call `stop_reason=max_tokens`; Codex rollout showed
`task_complete.last_agent_message: null`.

| # | Cause | Fix | State |
|---|---|---|---|
| 1 | Adapter sent `stream:false` upstream and replayed a fake SSE after the whole reply, so every call was 60-110 s of silence and any 429/529 looked like a hang | Live Anthropic SSE → Responses SSE translation, block by block | VERIFIED live |
| 2 | Hardcoded `max_tokens: 8192`; Codex sends no `max_output_tokens`; long final answers came back `status: incomplete` and Codex dropped the turn | Continuation engine: `max_tokens` = model ceiling (Fable 128k, Haiku 64k); on `max_tokens` or a mid-stream drop the adapter replays the partial blocks + a marker user turn and keeps streaming into the same Codex response | VERIFIED on Haiku (30-item list across 6 segments, numbering intact); Fable path UNVERIFIED end to end, see §4 |
| 3 | Thinking blocks discarded and `reasoning` items skipped on replay, so Fable re-reasoned from scratch every tool call | Thinking blocks (with signatures) round-trip as base64 `encrypted_content` on Codex `reasoning` items; continuation boundaries are encoded there too | VERIFIED signature replay on Fable before the 429 window |
| 4 | Codex's base prompt told Fable it is GPT-5, demanded an "old friend" personality, forbade headers, mandated commentary every 60 s | `model_instructions_file` (documented as a replacement, confirmed by capture) points at a 4.6k-char Claude prompt that keeps every Codex tool contract | VERIFIED by capture |
| 5 | 529/500/mid-stream drops never retried; a stream ending before `message_stop` was reported as success; `status:incomplete` sent as `response.completed` (Codex only honours `response.incomplete`) | Retries with exponential jitter up to 6 attempts on 408/429/5xx before content; drop → continuation; `incomplete` no longer emitted | VERIFIED by fault injection (429, 529×2, 500, mid-stream drop) |
| 6 | UTF-8 split across TCP chunks corrupted text and signatures | `StringDecoder` | VERIFIED (mixed-script + emoji test, zero replacement chars) |
| 7 | ~2.2M tokens/day of Anthropic cache rewrites because the ChatGPT-app node REPL injected `mcp__cua_repl` on turn 2 | `[mcp_servers.node_repl] enabled=false` and `mcp_optional_startup_grace_ms=0` in the Fable profiles; explicit breakpoints on last tool + last system block | VERIFIED tool list now identical turn 1→2 except `tool_search` |
| 8 | Codex client idle timeout 300 s cut long reasoning calls (one 294.5 s client-abort in the logs) | `stream_idle_timeout_ms = 900000` in `~/.codex/config.toml` | applied, UNVERIFIED under load |
| 9 | `apply_patch` grammar hidden behind a bare "raw input" wrapper | Grammar (lark) now included in the tool description | applied; Codex e2e `apply_patch` on Fable UNVERIFIED |

## 3. Facts learned about the platform (all VERIFIED, save yourself the probes)

- Fable 5.1 per-call output ceiling is 128,000 (`max_tokens: N > 128000` → 400). Haiku 4.5 is 64,000.
- Fable does not support assistant prefill (400 "This model does not support assistant message prefill"). Continuation must be a user turn. A marker like "[System: your previous message hit the output token limit … continue exactly where you stopped]" resumes mid-sentence cleanly.
- Fable rejects `tool_choice` `any` and `tool` (400). The adapter downgrades both to `auto`.
- A thinking block cut by `max_tokens` still carries a signature and can be replayed; a partial `tool_use` cannot, so the adapter discards it and asks the model to re-issue the call. If the re-issued call is cut again, it gives up with a visible note rather than looping.
- `count_tokens` works through Bifrost (`/anthropic/v1/messages/count_tokens`).
- The 5-hour plan limit surfaces as a generic `429 rate_limit_error` with body `{"message":"Error"}` on premium models while Haiku still answers; read the `anthropic-ratelimit-unified-*` headers on a direct call to tell it from a real rate limit.
- Codex 0.152.1: profiles must live in `<name>.config.toml`; `model_instructions_file` replaces the built-in prompt (developer_instructions and AGENTS.md stay additive); `mcp_optional_startup_grace_ms` and `[mcp_servers.x] enabled` are valid in a profile file; there is no working toggle for `tool_search`; Codex rewrites the `tool_search` description on turn 2 as MCP servers finish loading, which costs one cache-prefix rewrite per session (~10-20k tokens). Codex ships a Claude-compatible hook engine behind `features.hooks` (a sibling session verified this; not used here).
- Codex only raises truncation UI on `response.incomplete`; a `response.completed` with `status:"incomplete"` is silently accepted as success.
- Codex sizes its context meter from `usage.input_tokens`; Anthropic's `input_tokens` excludes cache reads, so the adapter sums `input + cache_read + cache_creation`.
- The "99-turn Fable session, 156k median, zero compaction" figure in the earlier memory note was measured on a gpt-5.6-sol rollout, not Fable. Real Fable sessions on disk are 1-4 turns. Do not cite it.

## 4. What is still open, in priority order

1. **Fable end-to-end after a real session.** Fable was 429 (5-hour window) for the entire rebuild; every engine test ran on Haiku through the identical path. First task: run `codex-fable exec` on a multi-tool job and a deliberately long answer, then read `claude_adapter_complete` lines in the adapter log (`segments`, `continuations`, `response_status`, `stop_reason`). Also confirm `apply_patch` edits land.
2. **Continuation quality on Fable at high effort.** Haiku resumed mid-sentence perfectly; Fable with adaptive thinking may open a continuation with a fresh thinking block. Check that text joins cleanly and that Codex renders the extra `reasoning` items sanely.
3. **`web_search` / `image_gen` built-ins** are dropped silently by the adapter (`responsesToolsToAnthropic`). Either map `web_search` to Anthropic's server-side web search tool or remove them from the Fable profile so the prompt is honest.
4. **`tool_search` description mutation** on turn 2 still busts the cache once per session. Options: pin the MCP list, or strip the mutable "Some of the tools may not have been provided" tail in the adapter so the description is stable.
5. **`[1m]` alias.** Untested. The adapter strips the suffix; Bifrost/Anthropic would need the 1M context beta header. Probes at 150k-250k input all hit the 5-hour 429, so window arithmetic is UNVERIFIED.
6. **Cache TTL.** `CODEX_BIFROST_CLAUDE_CACHE_TTL=1h` is wired but off (2× write cost, 0.025× read on Fable). Worth enabling for overnight agents once §1 is green.
7. **Console/checkpoint parity.** A sibling session found Codex's hook engine can host the same hooks Claude Code uses (`~/.claude/console/bin/console-post`, `~/.claude/hooks/session-checkpoint-writer.mjs`). Not started.
8. **Bifrost log columns.** Streamed calls land in `logs.db` with empty `stop_reason` and `params`; only the adapter log has the truth. If you want SQL over outcomes, log `stop_reason` into Bifrost metadata or keep using the JSONL.

## 5. How to verify without burning Fable

```bash
# health
curl -s http://127.0.0.1:8084/health
# adapter through Haiku (same code path, cheap)
curl -s http://127.0.0.1:8084/openai/v1/responses -H 'content-type: application/json' \
  -d '{"model":"CodexProxy/claude-haiku-4-5-20251001","stream":false,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Reply OK"}]}]}'
# full Codex loop on Haiku with the Fable profile
codex exec --profile fable -c 'model="CodexProxy/claude-haiku-4-5-20251001"' --skip-git-repo-check "echo hi then reply DONE" </dev/null
# fault injection: see tests/README section in README.md
```

Adapter log line to read after any run:
`grep claude_adapter_complete ~/.codex/codex-bifrost-selector-normalizer.out | tail -1`

## 6. Rollback

`launchctl kickstart -k gui/$(id -u)/com.siso.codex-bifrost-selector-normalizer` after copying a
`.bak-*` over `~/bin/codex-bifrost-responses-normalizer.mjs`. The profiles are additive; deleting
`model_instructions_file` from `fable.config.toml` restores the Codex prompt. Nothing here touches
`~/.codex/config.toml` except the idle timeout line.
