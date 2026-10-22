## What and why

<!-- One paragraph: the problem, and how this change solves it. Link the issue. -->

## How it was verified

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `pnpm test:integration` (if queue, database or worker code changed)
- [ ] `make e2e` (if playback, delivery or infrastructure changed)
- [ ] `make tf-validate` (if Terraform changed)

## Checklist

- [ ] Docs updated (README, `docs/`, configuration reference) for any behavior or config change
- [ ] New migration instead of editing an applied one
- [ ] No secrets, account IDs or real hostnames (`make sanitize` is clean)
- [ ] Security-relevant change? Described the threat and mitigation above
