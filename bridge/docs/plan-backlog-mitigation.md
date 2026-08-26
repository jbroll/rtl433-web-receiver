# Backlog mitigation plan

Every entry in [`backlog.md`](backlog.md) is assigned to exactly one batch below,
or to [Not doing yet](#not-doing-yet) with a reason. Each batch is meant to land
as one commit. Batch numbers give the intended order; [What blocks
what](#what-blocks-what) says which of them are actually ordered and which are
independent.

Claims that did not survive reading the code are called out in [Backlog claims
that need correcting](#backlog-claims-that-need-correcting). Everything else in
this plan was checked against the source in this checkout.

## 1. Token store hardening

Backlog entries: rotate-before-persist, `0644` token file, trim on read but not
on write, no fsync and a fixed `.tmp` path.

Files: `src/token-store.js`, `src/server.js`, `test/token-store.test.js`,
`docs/install.md`, `docs/user-manual.md`.

Rewrite `rotate` so the on-disk write happens before `current` is reassigned,
and let the write's exception propagate untouched, so a failed persist leaves the
old token live and the caller's `500` tells the truth. Trim in `rotate` as well
as at construction, and reject a token that trims to empty there rather than
persisting one; `src/server.js`'s `/auth/rotate` check should trim before its
`length === 0` test so HTTP and the store agree on what an empty token is.
Pass `{ mode: 0o600 }` to `writeFileSync`, and give the temp file a unique
suffix (`${path}.${process.pid}.${counter}.tmp`) so two rotations cannot collide
on one name. For durability, open the temp file with `openSync`, `writeFileSync`
the fd, `fsyncSync` it, close, `renameSync`, then open the containing directory
and `fsyncSync` that too; on a platform where the directory `fsync` throws
`EPERM` or `EISDIR`, swallow that one error rather than failing the rotation.

Docs: `install.md`'s `AUTH_TOKEN_PATH` row and `user-manual.md`'s rotation
section both need a line saying the file is written `0600` and that the
directory holding it should not be world-readable. Neither says anything about
file permissions today.

Tests, all in `test/token-store.test.js`: rotation into a directory that does not
exist throws and leaves `get()` returning the old token; the persisted file's
mode is `0o600` (`statSync(path).mode & 0o777`); a token with surrounding
whitespace comes back identical from a reopened store; an all-whitespace token
is rejected by `rotate` rather than persisted. The fsync calls are not directly
observable, so assert them by spying is not worth it — the test that matters is
that rotation still round-trips.

Risk: low for the mode and trim changes. The write-then-assign reorder changes
the failure semantics of an endpoint that currently reports `500` while having
half-succeeded, which is the point. The `fsync` calls add a disk round trip to
`/auth/rotate`, a request that happens by hand.

## 2. Certificate reload for the embedded broker

Backlog entry: the embedded broker reads cert and key once and never reloads
them, while `deploy.conf` includes `letsencrypt` and `secrets.env.example`
points `TLS_CERT`/`TLS_KEY` at `/etc/letsencrypt/live/weather.rkroll.com/`.

Files: `src/embedded-broker.js`, `test/embedded-broker.test.js`,
`docs/architecture.md`.

Keep the initial `readFileSync` pair, and add an `fs.watch` on each of the two
paths (certbot replaces the symlink target, so watch the resolved path's
directory as well, and re-resolve on every event). On a change, debounce for a
second, re-read both files, and call `server.setSecureContext({ cert, key })`.
If either read or the call throws, log and keep the running context. Unref the
watchers so they do not hold the process open, and close them in `close()`.

Test: write a cert and key pair to a temp directory, start the broker, connect a
client, overwrite the files with a second self-signed pair, wait for the watcher,
then connect a fresh client and assert it sees the new certificate's subject via
`socket.getPeerCertificate()`. `test/embedded-broker.test.js` already has a
`selfSignedCertFiles()` helper to build on.

Docs: `architecture.md`'s embedded-broker section should say the TLS context is
reloaded on file change and why (renewal every 60 days against a 90-day
lifetime).

Risk: medium. `fs.watch` behaviour differs across platforms and certbot's
replace-and-symlink dance is easy to miss; a debounce that fires mid-write reads
a truncated file, which is why the failed read has to be non-fatal.

## 3. Constant-time token comparison

Backlog entries: `tokenMatches`'s comment does not describe what it does, and it
dereferences `expected.length` before any type check.

Files: `src/auth.js`, `src/token-store.js`, `src/server.js`,
`src/embedded-broker.js`, `test/auth.test.js`.

Compare SHA-256 digests instead of raw bytes. `tokenMatches(provided, expected)`
becomes: return `false` unless both arguments are a string or a `Buffer` with
non-zero length, then `timingSafeEqual(sha256(provided), sha256(expected))`.
Both digests are 32 bytes, so the length guard that leaks an oracle disappears
and `timingSafeEqual` can never throw on a length mismatch. Rewrite the comment
to say what the digest buys: length independence, and one place that has to be
right. Have the token store cache the digest of the current token alongside it,
exposed as `digest()`, and let `authorized()` in `src/server.js` and the aedes
`authenticate` hook in `src/embedded-broker.js` pass that instead of a string,
so the per-request `Buffer.from(expected)` and hash go away on the hot path.

Tests in `test/auth.test.js`: `undefined`, `null`, `''`, a number, and `{}` as
`expected` all return `false` without throwing; a right and a wrong token of
different lengths behave as before. Add one asserting the aedes path survives a
nullish expected token, since that is the caller the backlog names.

Risk: low, but it touches the only gate on HTTP `POST` and MQTT `CONNECT`. The
digest cache in the store must be invalidated inside `rotate`, or a rotation
silently keeps accepting the old token — this is the one way to get it wrong.

## 4. Request input validation

Backlog entries: `readBody` has no size cap and no timeout; `/auth/rotate`
dereferences `parsed.token` without checking `parsed` is an object; `POST`
validates `body.toString('utf8')` and publishes the raw `body`.

Files: `src/server.js`, `test/http.test.js`, `test/rotate.test.js`,
`docs/user-manual.md`, `docs/binding.md`.

Give `readBody` a byte limit and an idle timeout. On `data`, accumulate a running
length and, past the limit, `req.destroy()` and reject with a marker error the
caller turns into `413`. Arm a timer on entry, reset it on each chunk, and on
expiry destroy and reject with a marker the caller turns into `408`. A sensible
cap is 64 KiB, which is far above any `$alias` or `$tz` body; make it a named
constant next to `ECHO_TIMEOUT_MS`'s counterpart in this file. Both marker cases
need distinguishing from the existing "client hung up" rejection, which
`src/server.js` deliberately answers with nothing.

Replace `JSON.parse(body.toString('utf8'))` in both the `POST` and the
`/auth/rotate` branch with a single decode through
`new TextDecoder('utf-8', { fatal: true })`, wrapped so a `TypeError` becomes
`400 'body is not UTF-8'`, and parse that string. This drops the second decode
and closes the gap where invalid bytes pass the gate and are then cached and
served as `application/json`. In `/auth/rotate`, guard `typeof parsed === 'object'
&& parsed !== null` before touching `parsed.token`, so a body of literal `null`
is `400` like `123`, `"str"` and `[]` already are.

Tests: in `test/http.test.js`, a body over the cap is `413` and the topic is
unchanged; a body sent as a slow drip that stalls past the idle timeout is `408`;
a body whose JSON string literal contains a stray `0x80` byte is `400` and
nothing reaches the cache (the existing "byte for byte" test at line 292 must
keep passing — a valid-UTF-8 non-ASCII payload is unaffected). In
`test/rotate.test.js`, a body of `null` and a body of `{"token":"   "}` are both
`400` and do not rotate.

Docs: `user-manual.md`'s status table and `binding.md`'s table both gain `408`
and `413`. `binding.md` should state the body cap is implementation-defined and
that an implementation may refuse an oversized body, since the binding currently
names no such status.

Risk: medium. The size cap is a behaviour change visible to any client posting a
large payload, and the idle timeout can fire on a genuinely slow uplink. Pick the
timeout generously (30 s) and count it from the last byte, not from the request
start.

## 5. Config parsing strictness

Backlog entries: `PORT=0x1F90` becomes 8080; `EMBED_BROKER` is compared against
the literal string `'false'` only.

Files: `src/config.js`, `test/config.test.js`, `docs/install.md`.

In `parsePort`, require the raw string to match `/^\d+$/` after trimming before
converting, so hex, `1e3`, `+80` and `Infinity` are all rejected with the
existing error message. Leave the `undefined`-means-default path alone. Add a
`parseBoolean(name, raw, defaultValue)` beside it, accepting `true/false/1/0/
yes/no/on/off` case-insensitively and throwing on anything else, and use it for
`EMBED_BROKER` so `EMBED_BROKER=0` disables embedding rather than silently
starting aedes and overwriting `brokerUrl`.

Tests in `test/config.test.js`: `PORT=0x1F90` throws (this fails today —
`Number('0x1F90')` is `8080`, an integer in range); `EMBED_BROKER` set to `0`,
`no`, and `FALSE` all give `embedBroker: false`; `EMBED_BROKER=maybe` throws;
`--no-embed-broker` still wins over any value.

Risk: low, and the blast radius is startup only. The one behaviour change an
existing deployment could notice is a `PORT` value that used to be tolerated now
refusing to start, which is the intent.

## 6. HTTP method and content-type conformance

Backlog entries: the three `405` responses omit `Allow` and `HEAD` is refused
where `GET` works; the dashboard is served without a charset.

Files: `src/server.js`, `test/http.test.js`, `docs/binding.md`.

Give `send()` an optional fourth argument for extra headers and pass
`{ allow: 'GET' }` on the `/events` refusal, `{ allow: 'POST' }` on
`/auth/rotate`, and `{ allow: 'GET, POST' }` on the trailing topic refusal.
Change the three `req.method === 'GET'` tests to accept `HEAD` as well —
`/events`, `GET /`, and the topic read. Node strips the body from a `HEAD`
response itself, so no other special casing is needed, but check that a `HEAD
/events` does not leave a stream in `clients`: gate stream registration on
`req.method === 'GET'` and answer `HEAD /events` with the headers and an
immediate `end()`. Add `; charset=utf-8` to the `text/html` content type for the
dashboard, and to the `text/plain` in `send()` while there.

Tests in `test/http.test.js`: a `POST /events`, a `GET /auth/rotate` and a
`DELETE /<topic>` each carry the right `Allow`; `HEAD /<topic>` is `200` with
`content-length` and an empty body where `GET` is `200`, and `404` where `GET`
is `404`; `HEAD /` returns the dashboard's headers; the dashboard's
`content-type` names the charset. Assert `bridge.clients.size === 0` after a
`HEAD /events`.

Docs: `binding.md`'s method table should say `HEAD` is served wherever `GET` is,
and that a refusal carries `Allow`.

Risk: low. The `HEAD /events` case is the only one with a way to go wrong, and
the client-set assertion catches it.

## 7. Shutdown correctness

Backlog entries: the shutdown chain has no `.catch` and never awaits
`httpServer.close()`; `SIGTERM` while a `POST` waits drops the request with no
status; `close()` in the embedded broker can hang on a pre-CONNECT socket.

Files: `bin/mqtt-http-bridge.js`, `src/embedded-broker.js`, `src/server.js`,
`test/embedded-broker.test.js`, a new `test/shutdown.test.js`,
`docs/architecture.md`.

Rewrite the signal handler as an `async` function guarded against re-entry, so a
second signal does not start a second teardown. Close the SSE streams, `await` a
promisified `httpServer.close()`, then `await broker.end()`, then
`await embedded?.close()`, all inside a `try`, with a `catch` that logs the error
and exits non-zero, and a hard `setTimeout(...).unref()` of a few seconds that
calls `process.exit(1)` if the whole chain has not finished. Without the timer,
awaiting `httpServer.close()` swaps an unhandled rejection for a hang.

For the in-flight `POST`, have `createBridge` expose the count of requests
currently awaiting `broker.publish` — `broker.waiting()` already reports the
pending-echo count, so the handler can poll it — and before ending the broker,
wait for it to reach zero or for a bounded grace period (one `ECHO_TIMEOUT_MS`)
to elapse. A publish still in flight at the deadline gets its `503` from the
existing timeout path, which is a status rather than a dropped socket.

For the embedded broker, track every connection the `net`/`tls` server accepts
in a `Set`, remove on `close`, and in `close()` call `server.close()` first, then
`aedes.close()`, then destroy any socket still in the set, resolving when the
server's callback fires. A pre-CONNECT socket is not an aedes client, which is
why `aedes.close` alone cannot be relied on to clear the way for `server.close`.

Tests: a new `test/shutdown.test.js` spawning `bin/mqtt-http-bridge.js` as a
child process is the only way to cover the handler — start it with
`--no-embed-broker` against a test broker, hold a `POST` open by black-holing the
uplink, send `SIGTERM`, and assert the request gets a `503` and the child exits
`0`. In `test/embedded-broker.test.js`, open a raw TCP socket to the listener,
send no bytes, call `close()`, and assert it resolves inside a couple of seconds.

Risk: medium-high. This is the batch most able to introduce a hang, and the
watchdog timer is what keeps a mistake from turning into a stuck supervisor. The
child-process test is slow and the most likely source of flakes; give it a
generous timeout.

## 8. SSE broadcast cost

Backlog entries: the frame is built once per client rather than once per message;
replay filters twice and `matchFilter` re-splits on every call; retained replay
is a full cache scan per filter.

Files: `src/sse.js`, `src/server.js`, `src/topic.js`, `test/events.test.js`,
`docs/architecture.md`.

Split `openStream`'s `send` into two: `matches(topic)` and `write(frame)`. Have
`broadcast(topic, payload)` in `src/server.js` build the frame string once —
`data: ${JSON.stringify({ topic, payload: decode(payload) })}\n\n` — and loop
`if (client.matches(topic)) client.write(frame)`. Export `decode` from `sse.js`
for that. Do not splice the raw payload text in to skip the parse round trip; the
parse-then-stringify normalises whitespace, number forms and duplicate keys, and
skipping it changes the bytes on the wire.

Have `openStream` pre-split each filter once at construction and give `topic.js`
a `matchSplit(filterSegments, topicSegments)` that `matchFilter` wraps. A
stream's filters never change (see `architecture.md`, "Filters are fixed per
connection"), so one split per filter per connection replaces one per message per
client.

Rewrite `subscribe`'s replay to iterate the cache once and test the whole filter
list per topic. Add `cache.entries()` returning the `Map`'s iterator and drop
the `replayed` `Set`, which exists only because the outer loop visits each topic
once per filter. `cache.match` stays for any other caller; if none remains, drop
it and its test.

Tests: the existing `test/events.test.js` cases for a topic matching two filters
arriving once (lines 36 and 158) are the regression guard and must keep passing
unchanged. Add one asserting two clients with different filters both get the
byte-identical frame for one message, and one asserting the replay order matches
cache insertion order now that it is a single pass.

Risk: low, with the caveat that replay ordering changes: today it is
filter-major, afterwards it is cache-insertion order. Nothing in `binding.md`
promises an order, but a client that happened to depend on it would notice.

## 9. SSE resource limits

Backlog entries: a slow reader is never dropped and `res.write` buffers without
bound; nothing caps the number of concurrent streams; nothing caps the number of
filters on one stream.

Files: `src/sse.js`, `src/server.js`, `test/events.test.js`, `docs/install.md`,
`docs/user-manual.md`, `docs/binding.md`.

In `openStream`'s write path, check `res.write`'s return value. On `false`,
count the bytes now sitting in `res.writableLength`, and when that exceeds a cap
(1 MiB is a reasonable first number), close the stream and drop it. A reader that
has fallen a megabyte behind is not going to catch up, and holding the buffer
costs the process more than the client is worth.

In `src/server.js`, refuse a `GET /events` with `503` when `clients.size` is at
a configured maximum, and refuse one with more than a configured number of `f`
parameters with `400 'too many filters'`. Both limits belong in `src/config.js`
as `MAX_SSE_CLIENTS` and `MAX_SSE_FILTERS` with defaults (64 and 16 are enough
for the dashboard's use), read through the same `parsePort`-style validation as
everything else. Since `subscribe` runs before the stream is registered, check
the filter count first so a rejected request never allocates a stream.

Tests in `test/events.test.js`: opening one more than `MAX_SSE_CLIENTS` streams
gets `503` and the earlier streams stay alive; a request with more than
`MAX_SSE_FILTERS` `f` parameters is `400` and adds nothing to `clients`. The
slow-reader drop is hard to force deterministically — open a stream, never read
from it, publish enough large messages to pass the cap, then assert
`bridge.clients.size` falls to zero. That test will be the slowest in the suite;
keep the cap configurable so it can be set low for the test.

Depends on batch 8, which reshapes the same write path.

Risk: medium. A cap set too low turns a working deployment into a refusing one,
so the defaults need to be comfortably above the dashboard's real usage, and
`install.md` has to document both knobs.

## 10. Dollar-leading topics

Backlog entries: `matchFilter('#', '$SYS/...')` returns `true` where MQTT
excludes `$`-leading topics from a `#` subscription; `POST /$tz` cannot work
against a real broker for the same reason, and the dashboard posts to
`${location.origin}/$tz` on every location change.

Files: `src/topic.js`, `src/broker.js`, `src/server.js`, `test/topic.test.js`,
`test/http.test.js`, `docs/architecture.md`, `docs/binding.md`.

Fix `matchFilter` first: when the first filter segment is `#` or `+` and the
first topic segment begins with `$`, return `false`. This is the MQTT rule and it
is a two-line change in `topic.js`.

That fix makes the `$tz` problem worse rather than better, so the two have to
land together. The bridge's `#` subscription cannot cover `$`-leading topics, so
`connectBroker` must subscribe to both `#` and `$*/#`-style filters. There is no
portable wildcard for "every `$` topic", so subscribe to `#` plus an explicit
list of the `$`-leading topic names the binding uses — today `$tz` and any
future sibling — resolving the `subscribed` promise only once every subscribe in
the list has succeeded. `$alias` is unaffected: it is always a last segment under
a source, never a leading one.

An alternative worth weighing at implementation time is to stop treating a
`$`-leading path as a raw topic in `src/server.js` and map `POST /$tz` onto a
non-`$` topic name internally. That keeps the broker subscription simple but
puts a rewriting rule in the binding, so it is a `binding.md` change, not a
bridge change, and needs the same decision as [batch 16](#16-binding-spec-gaps).

Tests: in `test/topic.test.js`, `matchFilter('#', '$SYS/broker/uptime')` is
`false`, `matchFilter('+/x', '$SYS/x')` is `false`, and `matchFilter('$SYS/#',
'$SYS/x')` is `true`. In `test/http.test.js`, a `POST /$tz` against the test
broker is `204` and a following `GET /$tz` returns the bytes — this fails today,
because aedes does deliver `$` topics on a `#` subscription only by accident of
not implementing the exclusion, so the test needs the explicit subscribe to be
meaningful. Check aedes's behaviour before writing the assertion; if aedes does
exclude them, today's `$tz` handling is already broken in the suite and the test
will show it.

Risk: medium. The `matchFilter` change silently narrows what every SSE
subscriber and every cache scan matches, and the `$tz` path only works if the
extra subscribe lands. The two must not be split across commits.

## 11. Retained-delete semantics

Backlog entries: a retained delete reaches SSE as an unmarked empty payload; a
foreign publisher's non-retained empty message masks a topic that still has a
retained message; `binding.md`'s alias claim disagrees with what a subscriber
sees; the dashboard's alias clear posts `""` and does not clear.

Files: `src/broker.js`, `src/sse.js`, `src/server.js`, `dashboard/src/alias.js`,
`test/events.test.js`, `test/http.test.js`, `docs/binding.md`,
`docs/architecture.md`, `docs/user-manual.md`.

Define a deletion in the binding and carry it end to end. Add a `deleted: true`
field to the SSE frame for a topic the bridge is removing, and emit it wherever
`cacheMessage` deletes an entry or caches a zero-length payload. That means
`cacheMessage` has to tell its caller what it did — return `'set' | 'deleted'` —
and `bin/mqtt-http-bridge.js`'s `onMessage` has to pass that through to
`broadcast`. A subscriber can then tell a deletion from an empty message, which
today it cannot.

For the dashboard, change `postAlias` in `dashboard/src/alias.js` so clearing an
alias sends a zero-length body rather than `JSON.stringify('')`, and have
`src/server.js` accept an empty `POST` body as a delete: skip the JSON parse,
publish a zero-length retained payload, and answer `204`. That is the MQTT
retained-delete primitive, reachable over HTTP. `readBody` returning an empty
buffer is currently a `400` ("body is not JSON"), so this is a deliberate carve
out in the `POST` branch and belongs in `binding.md`.

The foreign non-retained empty message masking a live retained one cannot be
fixed by caching alone — the bridge cannot see the broker's retained set without
resubscribing. Narrow it instead: cache a zero-length non-retained payload as a
distinct "empty message" marker rather than deleting or shadowing, so `GET`
still answers `404` (an empty body is not JSON) but a reconnect is not required
to recover. Document the residual gap in `architecture.md` where the current text
already describes it.

Tests: in `test/events.test.js`, a retained delete seen live arrives as a frame
with `deleted: true`, and an ordinary empty message does not. In
`test/http.test.js`, an empty-body `POST` to a `$alias` topic is `204` and a
following `GET` is `404`, and a subscriber connecting afterwards is not replayed
the topic. The existing test at line 269 (retained delete leaves the topic `404`)
is the regression guard.

Docs: `binding.md` needs the empty-body-deletes rule, the `deleted` field on the
SSE frame, and a correction to its test list, which currently says a device with
no alias omits the topic without saying what happens to a deleted one.

Depends on batch 8 (frame construction moves) and batch 10 (`$`-leading topics
change what a subscriber matches).

Risk: high, relative to the rest. It changes the wire format of the SSE frame,
the meaning of an empty `POST` body, and the dashboard at the same time. The
frame change is additive, so an old client ignores it, but the dashboard and the
bridge have to be deployed together for the alias clear to work.

## 12. Broker readiness and status

Backlog entries: no status endpoint; `503` is decided from `broker.connected()`
at request time; `connected()` reflects CONNACK only, not whether the `#`
subscription landed; every reconnect issues a duplicate SUBSCRIBE.

Files: `src/broker.js`, `src/server.js`, `bin/mqtt-http-bridge.js`,
`test/broker.test.js`, `test/http.test.js`, `docs/user-manual.md`,
`docs/binding.md`, `docs/architecture.md`.

Have `connectBroker` track readiness as its own flag: set on a successful
SUBACK, cleared on `close` and on a subscribe error. Rename the exported check to
`ready()` and have `src/server.js`'s two `503` gates use it. `connected()` can
stay for the status endpoint, where the distinction is the point. Set
`resubscribe: false` in the `mqtt.connect` options so the manual subscribe in the
`connect` handler is the only path re-establishing `#`; the manual one cannot be
deleted instead, because the `subscribed` promise and the error clearing hang off
its callback.

Add `GET /status` returning JSON: whether the broker is connected, whether the
subscription is up, the broker label from `brokerLabel`, the cache size, the
number of SSE clients, and the last reported error message. Reserve it the way
`/events` and `/auth/rotate` are, ahead of topic parsing, and leave it
unauthenticated — it names no secrets, `brokerLabel` having already stripped
credentials. This makes it a third reserved path, which is the subject of
[batch 16](#16-binding-spec-gaps).

The in-flight race — a request that passes the gate and then finds the broker
gone — is not closed by any of this and cannot be, since the check and the work
are separate steps. What the readiness flag does is shrink the window and stop a
`404` being served from a cache the bridge knows is stale.

Tests: `test/broker.test.js` gains a case using the existing
`refuseSubscribe: true` option in `test/helpers/broker.js` — the bridge reports
the error and `ready()` stays false, so `GET /events` is `503` rather than a
stream that carries nothing. A packet-counting test for the duplicate SUBSCRIBE
needs the test proxy in `test/helpers/broker.js` to count SUBSCRIBE packets
crossing it; assert exactly one per connect across a restart. `test/http.test.js`
gains a `/status` shape test in both the connected and broker-down states.

Depends on batch 6, since `/status` needs the `Allow` handling and `HEAD`
support to be consistent with the other reserved paths.

Risk: medium. `resubscribe: false` puts the whole reconnect path on the manual
subscribe, so a bug there means a bridge that reconnects and caches nothing. The
`refuseSubscribe` test is what covers it.

## 13. Packaging and build

Backlog entries: `esbuild` is in neither of the bridge's dependency lists while
`scripts/build-dashboard.js` reaches into `../../dashboard`; the package declares
a `bin` with no `files` field and is not published anywhere.

Files: `bridge/package.json`, `bridge/scripts/build-dashboard.js`,
`docs/development.md`, `docs/install.md`, `README.md`.

`esbuild` is a dependency of `dashboard/package.json` and is present in
`dashboard/node_modules` in this checkout, so `npm run build` works here today;
the failure is a fresh clone where only the bridge's dependencies were installed.
Two options, and the choice is the whole content of the decision: add `esbuild`
to the bridge's `devDependencies` so the build stands alone, or drop
`scripts/build-dashboard.js` from the bridge entirely and have the dashboard's
own build write into `bridge/public/`. The second is the honest shape — the
bridge does not otherwise know the dashboard exists, and `DASHBOARD_HTML` is a
path, not a build step — but it moves a documented workflow, so it needs a
`development.md` change in both projects.

Whichever is chosen, add a `files` field listing `bin`, `src`, `public`, and
`README.md`, so a published tarball carries what the `bin` entry needs. Whether
to publish to a registry at all is a separate decision; if the answer is no, the
`bin` entry should stay (it makes `npm link` work from a clone) and `README.md`
should say the install path is a clone, which it can then stop implying
otherwise.

Test: `test/build.test.js` running `npm run build` in a temp copy of the bridge
with only its own `node_modules` present would prove it, but it is slow and
touches the network. The cheaper check is a `development.md` step someone follows
by hand. Do not add a test that only passes because `dashboard/node_modules`
happens to exist in the working tree.

Risk: low. Nothing in the request path changes.

## 14. Authenticated writes from the dashboard

Backlog entries: `Access-Control-Allow-Origin: *` lets any page a user visits
read and write a reachable bridge; the dashboard's alias `POST` has no way to
send `Authorization: Bearer`.

Files: `dashboard/src/alias.js`, `dashboard/src/settings.js`, a new dashboard
settings surface, `docs/user-manual.md`, `dashboard/docs/`.

The bridge side needs nothing. The comment in `src/server.js` is right that a
wildcard origin adds nothing when `AUTH_TOKEN` is set, since a cross-origin
caller has no way to learn the token, and an origin allowlist is not a defence
against a non-browser client that sends whatever origin it likes. What is missing
is the dashboard's ability to hold a token at all.

Add a token field to the dashboard's settings, stored in `localStorage` beside
the existing alias store, scoped per bridge origin so a dashboard pointed at two
bridges keeps two tokens. Have `postAlias` and the `$tz` post in
`settings.js` attach `Authorization: Bearer <token>` when one is stored for that
origin. On a `401`, surface it in the UI rather than only `console.error`, which
is all either call site does today.

Test: a dashboard unit test that `postAlias` attaches the header when a token is
stored for that origin and omits it otherwise, with `fetch` stubbed. An
end-to-end test through `test/helpers/dashboard-fixture.js`, whose
`startTestBridge` already takes an `authToken`, proves the round trip.

Depends on batch 11, which changes what the alias clear posts. Land them in that
order or the dashboard changes twice.

Risk: low for the bridge, medium for the dashboard, which grows a settings
surface and a place to leak a secret into a screenshot. Do not log the token.

## 15. Test coverage gaps

Backlog entries: `test/helpers/bridge.js` builds the bridge in one synchronous
step so the `bridge?.broadcast` and `ending` guards are untested;
`bin/mqtt-http-bridge.js` has no test at all; `src/sse.js`'s keepalive timer is
never exercised.

Files: `test/helpers/bridge.js`, a new `test/bin.test.js`,
`test/events.test.js`.

Several of the gaps this entry lists are closed by earlier batches: the
token-store cases by batch 1, the `/auth/rotate` body cases by batch 4, and the
signal-handler shutdown order by batch 7's child-process test. What remains is
the wiring and the timer.

For the wiring, extend the child-process harness batch 7 introduces: start
`bin/mqtt-http-bridge.js` with `--auth-token-path` pointing at a temp file and
assert that a `POST /auth/rotate` through HTTP gates a subsequent MQTT `CONNECT`
by the new token, which is the shared-`tokenStore` handoff the architecture
document describes. Add a case starting it with `--dashboard-html` and asserting
`GET /` serves that file. `parseArgs` wiring is covered incidentally by every
flag those cases pass.

For the keepalive, give `openStream` an injectable interval so a test can set it
to a few milliseconds, open a stream, and assert two `:keepalive` frames arrive
with no publish in between. `test/helpers/bridge.js`'s `readEvents` skips
non-`data:` frames, so the test needs to read the raw stream rather than go
through it.

The `bridge?.broadcast` and `ending` guards stay untested. The startup ordering
one needs a message delivered between `connectBroker` returning and `bridge`
being assigned, which is a window inside one synchronous block; the `ending` one
needs an out-of-process timing the backlog already records as unreproducible.
Leave both, and leave the backlog entry for them, rather than restructuring the
helper to manufacture a window that production does not have.

Depends on batch 7 for the child-process harness.

Risk: low. Test-only, though the child-process cases are the flakiest thing in
the suite.

## 16. Binding spec gaps

Backlog entry: `/auth/rotate` is reserved by the bridge but appears nowhere in
`binding.md`, whose spec reserves nothing but `/events`.

Files: `docs/binding.md`.

State the rule rather than the instance. Add a section saying an implementation
may reserve paths under a single declared prefix, name that prefix, and move
`/auth/rotate` and the `/status` endpoint from [batch 12](#12-broker-readiness-and-status)
under it. Anything not under that prefix is topic space. This also settles where
the `$tz` rewrite from [batch 10](#10-dollar-leading-topics) would live if that
route is taken.

Moving `/auth/rotate` breaks any client using it, of which the only one is
`test/rotate.test.js`. Doing it now costs nothing; doing it after the endpoint
has a second consumer costs a migration.

Test: `test/rotate.test.js` updated to the new path, plus a case asserting the
old path is treated as an ordinary topic.

Depends on batch 12, which adds the second reserved path that makes the rule
worth writing.

Risk: low, and entirely a decision about the spec rather than the code.

## What blocks what

Batches 1 through 7 are independent of each other and can land in any order;
they are numbered by severity, worst first. A lockout on a failed rotation and a
world-readable secret are the two entries with a live consequence on the
`weather.rkroll.com` deploy.

The real dependencies:

- 3 depends on 1 — the digest cache lives in the token store.
- 9 depends on 8 — both rewrite `openStream`'s write path.
- 11 depends on 8 and 10 — the frame construction moves in 8, and 10 changes what
  a subscriber matches.
- 12 depends on 6 — `/status` should be consistent with the other reserved paths
  on `Allow` and `HEAD` from the start.
- 14 depends on 11 — the alias clear changes shape there.
- 15 depends on 7 — it reuses that batch's child-process harness.
- 16 depends on 12 — the second reserved path is what makes the rule worth
  writing.

Everything else is free. Batch 13 touches nothing in the request path and can go
at any point.

## Backlog claims that need correcting

**`connected()` is "at odds with what `docs/architecture.md` says the check is
for."** The defect is real: `connected()` returns `client.connected`, which is
CONNACK only, and both `503` gates in `src/server.js` use it. But
`architecture.md` never says the `503` check covers the subscription. Its
"Starting without a broker" section (lines 106-110) gives that job to
`broker.subscribed`, a separate promise, and says a broker refusing the
subscription "leaves it pending and reports the error." The conflict is between
`connected()` and the intent described there, not with a claim the document
makes about `connected()`. Reword the entry when [batch 12](#12-broker-readiness-and-status)
lands.

**`binding.md`'s alias test-list item is not met.** Partly. The list says "a
device with no alias omits the topic rather than returning an empty string," and
`test/http.test.js` line 134 asserts exactly that for a never-set alias: `GET` is
`404`. What actually diverges is narrower than the entry implies — only the
retained-delete case, and only over SSE, where a subscriber connecting after a
`$alias` delete is replayed the topic with `payload: ""` while `GET` says `404`.
The HTTP path is correct in both cases.

**The TLS-mode self-connection is untested.** Overstated.
`test/embedded-broker.test.js` line 127 builds exactly the self-connection
`bin/mqtt-http-bridge.js` makes, including `username: 'bridge'` and the
`rejectUnauthorized: false` TLS option, and drives a publish through it. Line 167
covers rotation gating a new `CONNECT` through a shared `tokenStore`. What is
untested is the `bin` file's wiring of those pieces, not the behaviour. Narrow
the entry.

**`npm ci && npm run build` fails.** True on a fresh clone with only the bridge's
dependencies installed, which is what the entry says. Worth recording that it
does not fail in the current working tree, because `dashboard/node_modules`
exists and `esbuild` is a declared dependency of `dashboard/package.json`. A test
written against the working tree would pass and prove nothing.

Everything else in the backlog was checked against the source and holds as
written. `Number('0x1F90')` is `8080` and `parsePort` accepts it; `readBody` has
neither a cap nor a timer; `res.write`'s return value is ignored in `sse.js`;
`rotate` assigns `current` before writing and passes no `mode`; `JSON.parse` of
literal `null` reaches `parsed.token` and throws; `resubscribe: true` sits
alongside a manual `client.subscribe('#')` in the `connect` handler; the shutdown
chain in `bin/mqtt-http-bridge.js` ends at `.then(() => process.exit(0))` with no
`.catch`; and `dashboard/src/alias.js` clears an alias by posting
`JSON.stringify('')`, two bytes the bridge caches as an ordinary message.

## Not doing yet

**Caching every topic through a `#` subscription does not scale.** This is a
design constraint, not a defect. Every other behaviour in the bridge — `GET`
answering without a round trip, retained replay on subscribe, the echo that makes
the broker the sole cache writer — is built on it, and `architecture.md` already
records it as the first thing to revisit if the bridge runs against a busy
broker. The bridge's actual broker is its own embedded aedes with a topic space
the receiver defines. Revisit when there is a real broker with a real topic count,
not before. Batch 9's stream and filter caps reduce the cost of a large cache
without changing the cache itself.

**A slow SSE subscriber is re-sent every matching retained topic on every
reconnect.** Fixing this means the bridge tracking, per subscriber, which
topic-value pairs that subscriber has already seen, which is exactly the
per-client server-side state `architecture.md`'s "Filters are fixed per
connection" section rejects for the receiver's planned embedded implementation.
The cheaper half — telling a subscriber which topics went away at a reconnect —
becomes possible once batch 11 gives the frame a `deleted` field, so revisit it
after that lands.

**A `POST` is held for the broker's round trip.** The alternative is writing the
payload locally as well, and `architecture.md` records that it was tried and
measured: over a 40 ms link, two sequential `POST`s made a `GET` return the new
value, then the old one, then the new one again. The bound stays until there is a
publisher whose throughput actually matters.

**An echo is matched by topic and payload, so a false `204` is possible.**
Closing this needs QoS 1 and a packet-identifier match, which changes the broker
contract and the cache-write ordering the whole design rests on. The failure
requires another publisher sending identical bytes to the same topic inside the
wait window, or a retained replay of the publisher's own earlier message across a
reconnect. Neither is reachable in the deployment this repo has.

**A `500` is still possible for an unforeseen error.** Not fixable, only
narrowed. Batch 4 removes the one path the backlog names. The generic handler
staying is correct; what should change is `binding.md` acknowledging that an
implementation may return `5xx` for its own faults, which belongs in batch 16's
spec pass if it happens at all.

**A retained delete seen live is indistinguishable from an empty message.**
Telling them apart needs MQTT 5's retain-as-published subscription option and
therefore an MQTT 5 broker; `aedes` is 3.1.1 only, so the suite could not cover
it. Batch 11 covers the case the bridge can control — the deletes it makes
itself, and what a subscriber is told about them. The foreign-publisher case
stays open and stays documented.
