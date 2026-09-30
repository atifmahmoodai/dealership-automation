# Operations guide

## Deploying

The app is one container (`Dockerfile`) that needs a PostgreSQL database. It works on any host that runs containers:

- **A single VPS** (Hetzner, DigitalOcean, Lightsail): use `docker compose up -d --build` with the included `docker-compose.yml`. Put Caddy or nginx in front for https.
- **Managed platforms** (Render, Railway, Fly.io, Google Cloud Run, AWS App Runner, Azure Container Apps): deploy the image and attach a managed PostgreSQL database. Set `DATABASE_URL` and the other variables from `.env.example`.

Checklist for going live:

1. **Environment:** `NODE_ENV=production`, and `PUBLIC_URL` set to the exact https address staff open.
2. **Proxy:** set `TRUST_PROXY=true` when a proxy or load balancer terminates https. Otherwise client IPs (rate limits, audit log) and https detection are wrong.
3. **Cookies:** leave `COOKIE_SECURE` unset, which means on in production. Browsers then only send the session cookie over https.
4. **Time zone:** set `TIMEZONE` to the dealership's zone, e.g. `Europe/London`. Quiet hours for automated messages follow it.
5. **First admin:** create it with `node dist/cli/create-admin.js --email … --name …`. The password comes from `ADMIN_PASSWORD` or a hidden prompt.

The server runs pending database migrations on start-up. An advisory lock makes this safe with several replicas. To run them separately (e.g. as a release step), use `node dist/cli/migrate.js`.

### Reverse proxy example (Caddy)

```
dealer.example.com {
  reverse_proxy app:8080
}
```

Caddy obtains and renews the https certificate automatically.

## Health checks

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /healthz` | Process is running | Liveness probe |
| `GET /readyz` | Database answers | Readiness probe / load balancer health check |

The Docker image has a `HEALTHCHECK` on `/readyz`.

## Logs and monitoring

- **Log format:** one JSON line per request (pino) with a request id. The id is also returned in the `x-request-id` header, so a user's error report can be matched to a log line.
- **Redaction:** cookies, CSRF tokens and authorization headers are removed from logs.
- **Alerts:** alert on repeated 5xx responses and on `/readyz` failing. Any log shipper works (Grafana Loki, Datadog, CloudWatch).
- **Activity log:** business actions (cars added and changed with price and status changes, cars switched on and off channels, channel settings, secret rotations and retries, follow-up rules, buyer opt-outs changed by staff, settings and user changes, logins and failed logins) are in the `audit_log` table. Admins can view them under **Activity log**.

## Backups

All business data (stock, listings and their sync history, buyers and conversations, rules and the activity log) is in PostgreSQL. Buyer names, emails and messages are personal data: restrict who can read backups, and delete old conversations in line with your privacy policy.

- **Managed databases** (RDS, Cloud SQL, Azure, Supabase, Neon): turn on automated backups with point-in-time recovery (7–30 days).
- **Self-hosted:** take a nightly logical dump and copy it off the server:

  ```bash
  docker compose exec -T db pg_dump -U auto -Fc auto > backup-$(date +%F).dump
  # restore into an empty database:
  docker compose exec -T db pg_restore -U auto -d auto --clean < backup-2026-09-29.dump
  ```

- **Test restores:** restore a backup to a scratch database regularly. A backup you've never restored is a guess.

## Upgrades

1. Take a backup.
2. Deploy the new image. Migrations run automatically, and each runs in a transaction, so a failed migration leaves the database unchanged and the app refuses to start.
3. Check `/readyz` and the logs.

## Scaling notes

- **Load:** a single instance comfortably handles thousands of cars across a handful of channels. The database pool size is `DATABASE_POOL_MAX` (default 10).
- **Several instances:** they share the database, and sessions live in the database, so any instance can serve any user. Rate limits are per instance (in memory).
- **Housekeeping:** expired sessions are purged hourly.

## Security routines

- **Staff changes:** when someone leaves, untick **Active** under **Settings → Staff logins**. This signs them out everywhere.
- **Locked accounts:** they unlock after 15 minutes, or immediately when an admin resets the password.
- **Updates:** keep the base image current. Rebuild regularly and run `npm audit` in CI.

## The worker

- Channel sync and message sending run in a background worker. By default it runs inside the web process (`WORKER=inline`). With more than one web process, set `WORKER=off` on them and run exactly one `node dist/cli/worker.js`; the job queue is safe with several workers anyway (jobs are claimed with `FOR UPDATE SKIP LOCKED`).
- A job stuck "running" for 10 minutes (a worker that died mid-call) is picked up again. Creating a listing twice is harmless: listing ids are derived from the car.
- A channel that keeps failing: jobs retry after 30 s, 2 min, 8 min, 32 min, ~2 h, then give up. **Channels › Retry failed** (or the dashboard's "Needs attention") sends them again once the cause is fixed. The channel's **Activity** shows every request and answer.
- Housekeeping runs hourly: channel activity older than 90 days and finished jobs older than 30 days are deleted.

## Channels and secrets

- Each channel has its own secret. Webhooks we send carry `x-timestamp` and `x-signature` (HMAC-SHA256 of `timestamp.body`); enquiries sent to `/api/inbound/<channel id>` must be signed the same way and be less than 5 minutes old.
- The feed address contains the channel's secret. If it leaks, **New secret** in the channel's settings changes it; give the marketplace the new address.
- Rate limits count signed-in users per session and everyone else per IP address, so a whole office behind one internet connection doesn't share one allowance.
