# Decisions

Judgment calls made while building the backend, as the spec asks (section 0). Each is
the choice and why.

## Build and tooling

**TypeScript 6.0, with `types: ["node"]` set explicitly.** `typescript-eslint` 8.71 supports
TypeScript below 6.1, so 6.0.x is the newest usable version. Setting `types` explicitly
means Node's types load the same way whatever the compiler's default is.

**`typescript` and `tsx` are dev dependencies of every workspace, not only the root.** The
Dockerfiles run `npm ci -w packages/shared -w services/<name>`, and npm installs only the
named workspaces' dependencies in that case, not the root's. Each image therefore needs
its own compiler. This was checked by running each Dockerfile's steps by hand, since no
Docker daemon was available while building.

**Production builds compile against the shared package's `dist/`.** Each
`tsconfig.build.json` turns off the `development` condition, so `tsc` reads
`@messenger/shared`'s compiled declarations instead of pulling its source into the
service's output. The shared package builds first (workspace order), with declarations.

**`requestIdOf(req)` instead of `req.id` in services.** `req.id` comes from pino-http's
type augmentation, which a service only sees when it compiles against the shared source.
In the production build it compiles against `dist/` and the augmentation is gone, so the
build broke. A tiny helper in the shared package avoids depending on it.

**esbuild's install script is left unapproved.** npm 11 no longer runs install scripts
until they're approved. esbuild's only checks its binary; `tsx` and `vitest` work without
it.

**The spec's infrastructure files are excluded from Prettier.** `compose*.yaml` and
`infra/` are copied exactly as the spec verified them, so the formatter must not touch them.

## Gateway: nginx

**The gateway is nginx 1.30 (Docker's official image), not Caddy (2026-10-17).** nginx is the
one students recognise and meet at work: W3Techs (17 Oct 2026) has it on 30.3% of websites
whose server is known, Caddy on 1.1%. Its built-in `limit_req` also suits the rate-limiting
lesson. Caddy had been inherited from the 2026-10-08 spec without a recorded reason.

**HTTPS through nginx's own ACME module, not Certbot.** The Debian-based official image
already installs `nginx-module-acme` (0.4.1 in 1.30.6; checked in the image), so production
only adds `load_module` and an `acme_issuer`. No Certbot container, renewal job or
first-start ordering. Fallback if the module misbehaves: Certbot, with the same `ssl_certificate`
lines pointing at its files. The Alpine image was not checked for the module, so we use the
Debian tag.

**Local and production differ by one template.** `gateway.conf.template` is
`http.conf.template` (port 80) locally and in CI, and `compose.prod.yaml` mounts
`https.conf.template` at the same path, which compose merges by target. `SITE_ADDRESS` is
gone; production sets `API_DOMAIN`, which the image's envsubst step fills in. It only
substitutes variables that are set, so nginx's own `$host` and `$request_uri` survive.

**`upstream` blocks with `resolve` and Docker's DNS (`127.0.0.11`).** nginx looks names up
at start and would keep stale IPs after a container is recreated by a deploy. With `resolve`
(open source since 1.27.3) and `resolver ... valid=10s` it re-checks. Tested: recreating the
three services swapped their IPs and the e2e flow still passed through the same gateway.

**All `proxy_set_header` lines live at server level in `routes.conf`.** A location that sets
any `proxy_set_header` of its own inherits none from above (nginx docs), which would silently
drop `X-Request-Id` on that route. The WebSocket `Upgrade`/`Connection` headers are safe to
send on every request: an empty `Upgrade` is not passed on, and `Connection` falls back to
`close`, nginx's default.

**Compression is gzip only.** nginx has no zstd module in its official module list; responses
are small JSON.

## Behavior

**Both tokens are in the JSON body and stored in localStorage (owner's decision).** The spec
had the refresh token in an HttpOnly cookie. The owner chose localStorage, with the app
attaching tokens itself, because students can see every step: login returns
`accessToken` and `refreshToken`, the app saves both, adds `Authorization: Bearer` to each
call, and sends `{ refreshToken }` to `/api/auth/refresh`. The trade-off, taught in the
frontend auth lesson: any script running on the page (an XSS bug, a compromised
dependency) can read localStorage, whereas an HttpOnly cookie can't be read by scripts.
Rotation and reuse detection still limit how long a stolen refresh token is useful. A side
effect: no cookies means no same-site requirement, so the frontend can live on any
domain, including `*.vercel.app`.

**WebSocket close code 1009 for an oversized frame, not 1008.** The `ws` library closes with
1009 ("message too big" in RFC 6455) when a frame exceeds `maxPayload`, and that is the
right code for it. Malformed frames after authentication still close with 1008.

**Login doesn't validate the username's format.** A badly formed username simply isn't
found, so it gets the same `INVALID_CREDENTIALS` response as any other failed login, and
the response never reveals why a login failed.

**Refresh rotation is a compare-and-swap.** The update only succeeds if the stored hash is
still the one that was checked. If two refreshes with the same token race, one wins and
the other gets `401 REFRESH_INVALID` without revoking the device. Reusing a token that
was already rotated earlier still revokes the device, as the spec requires. The frontend
serializes refreshes across tabs with the Web Locks API and re-reads localStorage once it
holds the lock, so two tabs don't race in practice.

**CORS is written by hand.** It's a few lines, and seeing them is more useful to students
than another dependency.

**The bootstrap admin's display name is "Admin".** The spec doesn't name it. "No admin
exists" means no user has the `admin` role; if `ADMIN_USERNAME` already belongs to a
member, nothing changes and a warning is logged.

**Summaries take the last message's `seq` from `last_seq`.** `Q-SUMMARIES` joins the last
message on `seq = last_seq` and doesn't select `seq` separately; they're equal by
construction.

## Tests and data

**The tests wait for the databases first.** Right after `docker compose up`, Postgres and
MongoDB run their init scripts on a temporary server that the host can't reach, even
though the containers already count as started. A vitest global setup retries until the
test databases accept connections.

**No seed data (2026-10-26).** The seed script and the dummy server were removed. A
fresh stack has only the bootstrap admin, who creates every other user, so what students
see locally matches a fresh production deploy.

**Local verification used Postgres 16, Redis 7 and the MongoDB 8.0 binary from the
official image.** The authoring environment had no Docker daemon. Compose and CI use the
versions in the spec.

## Stage 2 (Redis)

**The broadcaster subscribes before the server says `ready`.** When a user's first socket
connects to a process, the WebSocket server waits for `SUBSCRIBE user:{id}` to finish and
only then sends `ready`. Otherwise a message published in between would reach no one on
this process, and the client's refetch on `ready` could run before it was stored.

**`Broadcaster` gained two optional hooks, `userConnected` and `userDisconnected`.** The
registry reports a user's first and last socket on a process; `RedisBroadcaster` uses
that to subscribe and unsubscribe, and `LocalBroadcaster` doesn't need them. The send code
is unchanged between the stages.

**auth-service's Redis connection fails fast.** It is only a cache, so it's created with
`enableOfflineQueue: false`: while Redis is down, cache calls fail at once and requests
fall back to Postgres instead of waiting for a reconnect. message-service keeps ioredis's
defaults, because a publish should wait out a short blip rather than be dropped.

**`createRedis` lives in the shared package**, as the spec's layout has it. That puts
`ioredis` in conversation-service's image too, although that service doesn't use Redis.

**A message's retry key is `clientMessageId`, not `clientId`** (renamed 2026-10-20).
`clientId` already means one logged-in device (auth-service's `clients` table, the JWT's
`cid`), and two meanings for one name confused readers. The key stays separate from the
message's own `id`: the server makes that one (a `BIGINT` identity), and the app can't know
it before the first answer arrives. Renamed everywhere: the API body, the shared types, the
`client_message_id` column and its unique constraint (whose name `storeMessage` matches),
and the `CLIENT_MESSAGE_ID_REUSED` error. `001_init.sql` was edited in place because no
database had applied it yet; a local one needs its message database reset.

## Course plan

Where each part of the backend is taught is tracked centrally in `current-progress.md` at
the repo root, not here. This file keeps only build decisions.
