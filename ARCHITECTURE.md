# Aha architecture boundaries

Aha uses ports and adapters. The dependency direction is:

```text
Web / CLI / MCP
       |
       v
Application services
       |
       v
Aha kernel  ---> model invocation port / checkpoint port
                         |
                         v
              provider, scheduler, file store
```

## Kernel

`src/engine.mjs`, `board.mjs`, `proposals.mjs`, `schema.mjs`, the operator catalogs and prompts define the reproducible search semantics. The kernel owns rounds, frozen snapshots, operator sampling, proposal lineage, validation and conservative degradation rules.

The kernel must not import HTTP/MCP transports, file persistence, configuration files, credentials, provider payload builders, rate limiters or Markdown presenters. External effects enter through `invoke` and `checkpoint` ports.

## Application layer

`src/application/` implements use cases shared by every entry point:

- `RunService`: run lifecycle, single-active-run policy, cancellation, persistence and events.
- `run_factory`: validates commands, resolves a runtime execution plan and creates a credential-free audit record.
- `model_executor`: provider invocation, throttling, retries and provider-level call audit.
- `run_executor`: connects the kernel to its ports, metrics and presentation.
- `ConfigService`: shared config overview, masking, persistence and model connectivity tests.

Runtime credentials never belong to a persisted Run. A resolved credential-bearing config is held only for the lifetime of the in-process execution.

## Adapters

`server.mjs`, `mcp.mjs`, `mcp_ui.mjs` and `cli.mjs` translate their protocols into application commands. They must not reproduce run lifecycle logic. `mcp_ui.mjs` is an administrative Web adapter for MCP setup; it is not part of the MCP protocol implementation.

`src/provider.mjs`, `transport.mjs`, `scheduler.mjs`, `store.mjs` and `config.mjs` are outbound infrastructure. Their current paths remain stable for compatibility, but the kernel does not depend on them.

`src/presenters/` creates delivery formats such as Markdown from structured kernel results.

## Tests that enforce the boundary

`tests/engine.test.mjs` includes boundary checks ensuring the kernel has no direct infrastructure imports and that serialized run records cannot contain an inline API key.
