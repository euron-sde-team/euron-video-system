# Contributing

Thanks for helping improve Euron Video System. This guide covers the workflow,
the bar a change has to clear, and the conventions the codebase follows.

## Ground rules

- **Open an issue first** for anything larger than a bug fix or a docs tweak, so
  we can agree on the approach before you invest time.
- **One concern per pull request.** A refactor and a feature are two PRs.
- **Security issues go through private reporting**, never a public issue. See [SECURITY.md](SECURITY.md).
- By contributing you agree your work is released under the [MIT License](LICENSE).

## Development setup

Requirements: Node 22+, pnpm 9 (`corepack enable`), Docker, and FFmpeg on your
`PATH` if you run the worker outside Docker.

```bash
pnpm install
make up          # Postgres + local AWS emulator + api + worker + console
make test        # unit tests across every package
```

[docs/guides/quickstart-local.md](docs/guides/quickstart-local.md) walks through the
full local stack, and [docs/guides/walkthrough.md](docs/guides/walkthrough.md)
tours the codebase by following one video from upload to playback.

## Before you open a pull request

Run all of these before opening a pull request. Each must pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
make tf-validate              # when you touched infra/terraform
scripts/check-sanitization.sh # no credentials, account ids or resource ids
```

Integration tests need Postgres:

```bash
TEST_DATABASE_URL=postgres://evs:evs@localhost:5432/evs_test pnpm test:integration
```

## Conventions

**Layering (api).** Routes → controllers → services → repositories. Controllers
only parse the request and shape the response, services hold the business
rules and throw typed errors from `@evs/core/errors`, and repositories are the
only code that queries the database.

**Queue writes are guarded.** Any `UPDATE` to a claimed `videos` or `jobs` row
includes `locked_by = $worker AND status = 'processing'` and reports whether it
landed. Read [ADR-0001](docs/architecture/adr/0001-postgres-as-the-queue.md)
before changing anything in `packages/core/src/queue`.

**Configuration is validated.** A new environment variable is added to the
schema in `packages/core/src/config/index.ts`, to `.env.example`, and to
[docs/guides/configuration.md](docs/guides/configuration.md) in the same PR. No
new code reads `process.env` directly.

**Database changes are new migrations.** Add `db/migrations/NNNN_description.sql`
and update `packages/core/src/db/types.ts`. Never edit an applied migration:
the runner refuses to start when a checksum changes.

**Comments explain why.** The code says what it does. Comments are for the
constraint, the incident, or the trade-off that made it this way.

**Style.** Prettier (`pnpm format`) and ESLint settle formatting debates. Use
TypeScript strict mode, and add no `any` without a comment saying why.

## Commit messages

Use the imperative mood with an optional scope: `worker: cap ladder to source bitrate`,
`api: add webhook redelivery`. Explain the *why* in the body when it is not obvious.

## Architecture decisions

A change that alters a documented decision (queue, encryption model, deployment
topology, tenancy) needs a new ADR in `docs/architecture/adr/`, using the existing
ones as a template.
