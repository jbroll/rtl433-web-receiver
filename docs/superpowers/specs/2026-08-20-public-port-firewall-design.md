# A firewall module for deploy.sh, driven by claim_port

## Why

The `weather.rkroll.com` deploy (see
[`2026-08-20-bridge-embedded-broker-deploy-design.md`](2026-08-20-bridge-embedded-broker-deploy-design.md))
needs TCP 8883 reachable from the public internet for the bridge's embedded MQTT
broker. That spec called it out as a manual step: `deploy.sh` has no firewall
module, so opening the port was left for whoever runs `deploy init` to remember,
with a note that a firmware connection failing silently is how it'd otherwise be
discovered. This spec makes it a declarative part of the deploy instead.

This work spans two repos: `deploy.sh` (the module, and the `claim_port`
extension it's built on) and `rtl433-web-receiver` (the `bridge/deploy.conf`
change that uses it).

## Non-goals

- `firewalld` or `nftables` support. The module targets `ufw` only — see
  "Platform scope" below.
- UDP rules. Every current and anticipated use (MQTTS) is TCP.
- Managing ports 80/443. Apache and Let's Encrypt predate this work and
  already function on every deploy that has them; nothing here touches them.
- Auto-deriving public ports from every `claim_port` call. A bind port is
  internal-only (proxied through Apache, or loopback) unless a module
  explicitly opts it in with `--public`.
- Installing, enabling, or disabling `ufw`. If it isn't already installed
  and active, the module skips with a warning rather than turning it on —
  see "Safety posture" below.

## Architecture

### `claim_port` gains a `--public` flag

`lib/port-registry.sh`'s `claim_port` currently does one thing: record
`port → owner` under `/var/lib/deploy.sh/ports/` on the target host, so a
collision is refused even when the conflicting service is stopped. That
registry is unchanged.

`claim_port` gains an optional `--public` flag, order-independent relative to
the existing `owner` argument:

```sh
claim_port <port> [owner] [--public]
```

When `--public` is present, `claim_port` additionally writes the claim to a
second host-local registry, `/var/lib/deploy.sh/public-ports/<port>`,
containing the owner — mirroring the existing registry's shape and its
reconcile-on-move step (an owner re-claiming a different public port releases
its previous one from this registry, the same way it already does for the
main one). This is implemented in `lib/port-claim.sh` (the script piped over
SSH and run as root) alongside the existing logic, not as a separate script,
since it's the same claim with an extra side effect.

A port claimed without `--public` never appears in the public registry and
stays firewalled off by default. `binary_service`'s `claim_port` call is
unaffected (no `--public`, no behavior change).

### New `firewall` module

Follows the existing module shape (`build.sh`, `install.sh`, `configure.sh`,
`start.sh`, `defaults.conf`, `module.info`):

- **`build`, `install`:** no-op, like `letsencrypt`'s `build.sh`.
- **`configure`:** the sync step. Lists every file in
  `/var/lib/deploy.sh/public-ports/` — the complete desired set of open ports
  across every app ever deployed to this host with `--public`, not just the
  current one. Diffs it against the module's own managed `ufw` rules (see
  tagging below), adds what's missing, removes what's no longer claimed.
  Runs in `configure` because that's where the two existing `claim_port`
  callers (`node_app`, `binary_service`) do their claiming, and stage
  execution is stage-major across `DEPLOY_TYPES` — every module's `configure`
  runs before any module's `start` — so placing `firewall` after the claiming
  modules in `DEPLOY_TYPES` is what makes the ordering work, matching how
  `letsencrypt` already depends on being listed after `apache`.
- **`start`:** no-op. The sync already happened in `configure`; there's no
  service to enable or restart.

**Tagging, so only this module's own rules are ever touched:** every rule it
adds carries `comment 'deploy.sh:<owner>'`, e.g.
`ufw allow 8883/tcp comment 'deploy.sh:mqtt-http-bridge'`. The sync only
ever considers `ufw status` lines carrying a `deploy.sh:` comment — a
hand-added rule (including the pre-existing SSH allow every `ufw`-enabled
host already has) is never modified or removed, and a port already open by
some other, untagged rule is left alone rather than double-added.

Sync logic:
1. Desired set = ports named by files in `/var/lib/deploy.sh/public-ports/`.
2. Current set = ports named by `deploy.sh:`-tagged `ufw` rules.
3. For each port in desired-but-not-current: `ufw allow <port>/tcp comment
   'deploy.sh:<owner>'`.
4. For each port in current-but-not-desired: `ufw delete allow <port>/tcp`.

### Platform scope

`ufw` only, gated on `$DEPLOY_PLATFORM == debian` (set by `lib/platform.sh`,
covers both Debian and Ubuntu — matches the README's stated remote
requirement, and it's the only platform anything currently deploys a public
port to). On `alma` or `void`, `configure.sh` logs `info` that the platform
isn't supported and returns 0 — the same "skip, don't guess" posture as the
rest of this design, rather than shipping an untested `firewalld` or
`nftables` path.

### Safety posture

The module never installs, enables, or disables `ufw`. Before syncing,
`configure.sh` checks `ufw status | grep -q "^Status: active"`; if `ufw`
isn't installed or isn't active, it logs a `warn` naming the ports that
would have been opened and returns 0 without touching anything. A deploy
that needs a public port therefore still succeeds even on a host with no
firewall configured — same as today, just with a clear message instead of
silence — rather than the module being the thing that turns a firewall on
(and potentially locks out SSH) as a side effect of an unrelated app deploy.

### `node_app` module gains `NODE_APP_PUBLIC_PORTS`

New `defaults.conf` field, default empty: `NODE_APP_PUBLIC_PORTS=""` — a
space-separated list of additional ports, distinct from `NODE_APP_PORT`
(which keeps claiming as internal-only, unchanged — it's the Apache-proxied
port on every current deploy).

`configure.sh` claims each one after the existing `claim_port
"$NODE_APP_PORT"` line:

```sh
for public_port in $NODE_APP_PUBLIC_PORTS; do
    claim_port "$public_port" "$APP_NAME" --public
done
```

`start.sh`'s `verify_listening "${NODE_APP_PORT:-}"` call extends to also
verify each port in `NODE_APP_PUBLIC_PORTS`, so a public port that fails to
bind fails the deploy the same way the main port already does.

## `weather.rkroll.com` deploy.conf change

In `bridge/deploy.conf` (`rtl433-web-receiver` repo):

```sh
export DEPLOY_TYPES="letsencrypt apache node_app firewall"   # was: letsencrypt apache node_app
...
export NODE_APP_PUBLIC_PORTS="8883"
```

`firewall` is appended at the end of `DEPLOY_TYPES`, after `node_app` (whose
`configure` stage makes the claim). No other field in this file changes.

## Testing

- `deploy.sh`'s `test/`: a new `test-firewall-module.sh` following the shape
  of `test-letsencrypt-module.sh` — covers the `--public` flag round-tripping
  through `claim_port`/`port-claim.sh` (public registry file written,
  reconciled on an owner's re-claim to a different port), the `configure.sh`
  add/remove diff logic against a faked `ufw status` output, the
  `deploy.sh:`-comment tagging (an untagged existing rule for the same port
  is left alone), the inactive/missing-`ufw` skip path, and the non-`debian`
  platform skip path.
- `port-claim.sh` already has direct test coverage (implied by its existing
  behavior being exercised via `test-*.conf` configs); the `--public` addition
  needs the same kind of direct invocation test, not just coverage through
  the `firewall` module's own tests.
- Deploy verification for `weather.rkroll.com` is manual, same as the parent
  spec: after `deploy init`, confirm `ufw status` shows the tagged 8883 rule,
  and confirm an `mqtt`-client connection to `mqtts://weather.rkroll.com:8883`
  succeeds from off-box (it was previously blocked at the firewall even with
  the broker listening correctly).

## What this unblocks

`weather.rkroll.com`'s `deploy init` no longer has a manual, undocumented
prerequisite — the previous spec's open item is closed. Any future module or
project needing a public port (not just this one) has a declarative path:
`claim_port <port> --public` plus `firewall` in `DEPLOY_TYPES`.
