# Context Core

Shared, dependency-free context filtering primitives used by experimental agent integrations.

This package was extracted because the Context Firewall depended on two files hidden inside the Agent Base context-manager extension. Keeping the primitives beside the adapter makes the public repository runnable and exposes the real dependency boundary.

It is an internal library, not yet an independently versioned Great Library Work. If the runtime and multiple repositories begin consuming it, promote it to a separate repository and Work through a compatibility bridge rather than copying it again.

## Exports

- `filter.js`: message text extraction and context-message filtering.
- `provider-filter.js`: provider-payload measurement and filtering.

The Context Firewall remains shadow-only. These primitives being available does not authorize mutation of live provider traffic.
