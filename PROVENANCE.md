# Provenance

## Initial extraction

- Date: 2026-07-30
- Source Work: SISO Agent Runtime / former Agent Base warehouse
- Source inventory: `gls:source-inventory:d3e37616-1005-4d67-b5c5-82684dceed70`
- Destination Work: `gls:work:e88d82a7-3a24-4aaf-8758-ea7372c3797a`

The first public extraction copied the current working versions of:

- `integrations/context-firewall`
- `integrations/headroom`
- `extensions/siso-context-manager/filter.js`
- `extensions/siso-context-manager/provider-filter.js`

The two context-manager primitives now live in `packages/context-core`. This makes the Context Firewall self-contained while preserving a visible bridge back to the runtime source. A later runtime extraction can depend on this package instead of maintaining a second copy.

The source checkout contained pre-existing tracked modifications and untracked files. The extraction therefore preserves current file content without claiming that it matches the warehouse's pinned public commit.

Excluded from the public repository:

- launchd files containing personal absolute paths;
- Python bytecode caches;
- runtime logs, metrics, state, and credentials;
- private Oracle fixture locations.

The repository-root MIT license from SISO Agent Base accompanies the extracted SISO-owned source. Headroom remains a separately owned dependency pinned in `packages/headroom/source.lock`; this repository does not redistribute the Headroom package itself.
