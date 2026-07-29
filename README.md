# SISO Agent Integrations

Experimental runtime adapters with explicit safety, evidence, promotion, and rollback contracts.

This repository is the public source home for integrations that are useful across the SISO Agent Stack but are not core runtime dependencies. An adapter remains experimental until its own promotion gate passes.

## Packages

| Package | Current state | Purpose |
|---|---|---|
| [`context-core`](packages/context-core/) | Internal library | Shared message and provider-payload filtering primitives used by the Context Firewall. |
| [`context-firewall`](packages/context-firewall/) | Shadow only | Measures projected context savings without modifying request or response content. |
| [`headroom`](packages/headroom/) | Opt-in pilot | Runs a pinned, lossless Headroom sidecar without changing existing provider routes. |

Neither package is globally enabled by installing this repository.

## Safety contract

- Loopback binds only.
- Existing provider routes remain unchanged unless the operator explicitly opts in.
- Request content must never enter aggregate telemetry.
- Transformations must fail open or fail closed according to the package contract.
- Promotion requires isolated tests, live canary evidence, and a documented rollback.
- A successful smoke test does not automatically make an adapter production-ready.

## Verify

```bash
npm test
```

The default suite exercises the Context Firewall in isolation and performs syntax checks on the staged Headroom package. Headroom's full Oracle and live-provider canaries require explicitly supplied local fixtures and provider configuration; see its package README.

## Library identity

- Work: `gls:work:e88d82a7-3a24-4aaf-8758-ea7372c3797a`
- Section: Agents
- Catalog: <https://great-library-of-siso.vercel.app/works/siso-agent-integrations/>

## Provenance

The initial packages were extracted from the SISO Agent Base warehouse on 2026-07-30. Machine-specific launchd files, runtime state, credentials, and private fixture paths were deliberately excluded. See [`PROVENANCE.md`](PROVENANCE.md).

MIT licensed. Experimental status is about operational readiness, not source availability.
