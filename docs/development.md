# Development

This repo contains four sub-projects. Each is built, tested, and released on its own:

- [`receiver/`](../receiver/README.md) — ESP32-S3 firmware
- [`bridge/`](../bridge/README.md) — Node service bridging MQTT to HTTP
- [`dashboard/`](../dashboard/README.md) — browser dashboard
- [`app/`](../app/README.md) — Capacitor shell for mobile builds

## Build and test

Each sub-project has its own build and test commands. See the README in each directory.

For the dashboard:

```bash
cd bridge && npm install     # dashboard/test/harness.js runs the real bridge
cd ../dashboard
npm install
npm test
npm run build
```

`bin/test.sh` runs every sub-project's suite in one command: the receiver's host tests and
its Playwright binding suite, then bridge and dashboard `npm test`. It expects
`node_modules` to already exist in each sub-project; on a fresh clone, install first:

```bash
npm ci --prefix receiver
npm ci --prefix bridge
npm ci --prefix dashboard
bin/test.sh
```

## Worktrees and merges

Feature work happens in isolated worktrees. Each worktree is a named branch that splits from `main`.

Merges into `main` must be fast-forwards. Before merging, rebase the worktree onto the current `main`:

```bash
git checkout feature/my-branch
git rebase main
git checkout main
git merge --ff-only feature/my-branch
```

A `prepare-commit-msg` hook in `.githooks/` rejects merge commits that are not fast-forwards. Point git at it:

```bash
git config core.hooksPath .githooks
```

Non-fast-forward merges are rejected with an error telling you to rebase first. The local config also guards against accidental non-FF merges:

```bash
git config merge.ff only
```
