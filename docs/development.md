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
cd dashboard
npm install
npm test
npm run build
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
