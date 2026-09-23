# SISO Agent Integrations

**In one line:** Experimental runtime adapters around the agent stack, including context filtering, a lossless sidecar and a Codex-to-Claude model adapter. District: `SISO_Agents` (`~/SISO_Workspace/SISO_Agents/siso-agent-integrations`).

## Purpose

This repository owns experimental adapters around the SISO Agent Runtime. It does not own the runtime, provider credentials, model routing policy, private fixtures, or operator state.

## Boundaries

- `packages/<adapter>/` owns its source, tests, safety contract, and promotion verdict.
- Never add credentials, request payloads, session content, machine-specific absolute paths, or generated runtime state.
- New adapters begin experimental and opt-in.
- Do not describe an adapter as production-ready without checked-in canary evidence and rollback instructions.
- Shared runtime behavior belongs in `siso-agent-runtime`, not here.

## Verification

Run `npm test` before pushing. Also scan the publication surface for secrets and absolute user paths.
