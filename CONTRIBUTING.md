# Contributing to ch4p

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- **Node.js** ≥ 22
- **corepack** enabled (`corepack enable`)
- **pnpm** is managed via corepack — do not install it globally

## Setup

```bash
git clone https://github.com/vxcozy/ch4p.git
cd ch4p
corepack pnpm install
corepack pnpm -r build
npx vitest run            # verify all tests pass
```

## Development workflow

1. **Fork** the repository and create a feature branch from `main`.
2. Make your changes — the monorepo has 19 packages under `packages/` and `apps/`.
3. Run the full check suite before pushing:

```bash
corepack pnpm -r build          # build all packages
npx vitest run                   # run all tests (2 449+)
corepack pnpm lint               # ESLint (0 errors required)
corepack pnpm -r exec tsc --noEmit   # typecheck
corepack pnpm audit              # 0 vulnerabilities required
```

4. Open a pull request against `main` with a clear description of what changed and why.

## Code standards

- **TypeScript strict mode** — all packages use `strict: true`
- **ESM-only** — all imports use `.js` extensions
- **No default exports** — use named exports everywhere
- **Tests** — new features need tests; aim for the existing coverage thresholds (90% lines/functions/statements, 85% branches)
- **Lint** — `pnpm lint` must exit with 0 errors. Warnings are acceptable but should be reduced over time.

## Commit messages

Write commit messages that explain **why**, not what. The diff already shows what changed.

```
Good:  Fix gateway hang when subprocess exits before stdin flush
Bad:   Update gateway.ts
```

## Project structure

```
packages/
  core/           # Trait interfaces, types, errors, utilities
  agent/          # Agent runtime: session, context, steering, worker pool
  providers/      # LLM providers (Anthropic, OpenAI, Google, etc.)
  engines/        # Execution engines (native, echo, subprocess)
  channels/       # 16 messaging adapters
  canvas/         # A2UI components, canvas state, WS protocol
  gateway/        # HTTP server, session routing, cron, webhooks
  tools/          # Agent tools (bash, file ops, browser, MCP, etc.)
  memory/         # Hybrid search (SQLite FTS5 + vector)
  security/       # Filesystem scope, command allowlist, secrets, sanitization
  supervisor/     # OTP-style supervision trees
  observability/  # Console, file, multi-observer logging
  skills/         # Skill discovery and registry
  voice/          # STT, TTS, voice wake
  tunnels/        # Cloudflare, Tailscale, ngrok
  plugin-x402/    # x402 micropayment plugin
apps/
  cli/            # CLI entry point
  web/            # Canvas workspace (React + tldraw)
```

## Adding a new channel, tool, or provider

See the how-to guides in [`docs/how-to/`](docs/how-to/):

- [Add a Channel](docs/how-to/add-channel.md)
- [Add a Tool](docs/how-to/add-tool.md)
- [Add a Provider](docs/how-to/add-provider.md)

## Reporting issues

- Use [GitHub Issues](https://github.com/vxcozy/ch4p/issues) for bugs and feature requests.
- For **security vulnerabilities**, see [SECURITY.md](SECURITY.md) — do not open a public issue.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
