# Messenger backend

The backend for the course's Messenger app: three Node.js services behind an nginx gateway,
with Postgres and MongoDB. The full design is in [`../backend-spec.md`](../backend-spec.md);
judgment calls made while building it are in [`DECISIONS.md`](DECISIONS.md).

## How it fits together

Every request from the React app goes to the **gateway** (nginx), which routes by path.
**auth-service** owns users and logins (Postgres database `auth`). **conversation-service**
owns conversations and who is in them (MongoDB). **message-service** owns messages, unread
counts and the WebSocket connections (Postgres database `message`). Services never touch
each other's databases: when conversation-service needs message data, it calls
message-service over internal HTTP. Members are fixed when a conversation is created, so
message-service keeps its own copy of the member list and can check membership and deliver
messages without asking anyone.

```
React app ──HTTPS /api/*, WSS /ws──> gateway (nginx)
                                       ├─ /api/auth/*, /api/users           -> auth-service :4001         -> Postgres "auth"
                                       ├─ /api/conversations                -> conversation-service :4002 -> MongoDB "messenger"
                                       └─ /api/conversations/:id/messages,  -> message-service :4003      -> Postgres "message"
                                          /api/conversations/:id/read, /ws
conversation-service ──internal HTTP──> message-service
```

## Run it

You need Docker with Compose, and Node.js 24 for the tests and scripts.

```bash
cd code/backend
cp .env.example .env
docker compose up            # builds dev images and starts everything with hot reload
# gateway: http://localhost:8080
npm install                  # once, for the tests
```

A fresh stack starts with one user: the admin, created from `ADMIN_USERNAME` /
`ADMIN_PASSWORD` in `.env`. Log in as the admin and add everyone else from Settings.
To start over from that state, `docker compose down -v` deletes the database volumes.

## Test it

```bash
docker compose up -d --wait postgres mongo   # the test databases
npm test                                     # unit and integration tests
docker compose up -d --build --wait          # the whole stack
npm run test:e2e                             # end-to-end, through the gateway
npm run lint && npm run typecheck
```

Each test's name starts with its id from the spec (A1 to A8, MS1 to MS11, C1 to C5,
R1 and R2, E1 and E2; the metrics tests are M1 to M5).

## Stages

The backend is built in two stages, which the course teaches in order:

- **Stage 1** (git tag `backend-stage-1`): no Redis. One process per service, and
  real-time delivery looks up sockets in memory (`LocalBroadcaster`).
- **Stage 2**: Redis for delivery across several message-service processes, and a cached
  user list. This is the "Scaling & Performance" lesson. See the spec's section 14.

## Observability (Module 5)

Each service serves Prometheus metrics at `/metrics` (on the Compose network only; the
gateway returns 404 for it). The gateway logs one JSON line per request with the same
`requestId` the services log, and `GET /api/health` is the public uptime check.

One Grafana Alloy container ships every container's logs and each service's metrics to
Grafana Cloud's free tier. It is off by default. To turn it on, add to `.env`:

```bash
COMPOSE_PROFILES=observability
GRAFANA_CLOUD_METRICS_URL=…   # Cloud Portal > your stack > Prometheus > Details
GRAFANA_CLOUD_METRICS_USER=…  # same page, the User number
GRAFANA_CLOUD_LOGS_URL=…      # Loki > Details: the URL, plus /loki/api/v1/push
GRAFANA_CLOUD_LOGS_USER=…     # same page, the User number
GRAFANA_CLOUD_TOKEN=…         # Access Policies: metrics:write and logs:write
```

Then `docker compose up -d`. Step-by-step setup: `../observability-spec.md`, section 7.

## Deploy

Production is one Google Cloud e2-standard-2 VM running this compose stack with
`compose.prod.yaml`; the runbook is [`../docs/deploy-gcp.md`](../docs/deploy-gcp.md), added with the production setup.
