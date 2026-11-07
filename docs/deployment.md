# Deployment (self-hosted server)

The server image contains the API and the built web app. PostgreSQL runs in its own container.
Images are built locally; nothing is published to a registry.

## Requirements

- Docker Engine with Compose v2, linux/amd64 or linux/arm64 (the Dockerfile uses only multi-arch
  base images; arm64 has **not** been test-built yet).
- About 2.5 GB RAM free during the image build (Node and Rust compile steps). Runtime needs far less.

## First start

```bash
cd infrastructure/docker
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD (e.g. `openssl rand -base64 32`) and PUBLIC_ORIGIN.
docker compose up -d --build
docker compose logs server | grep "setup token"
```

Open the app in a browser: while the server has no users, Mavyn shows **Set up the server** by
itself. Paste the setup token from the log, choose the administrator's name and password, and pick
or create a library to sync. The token works once and changes on every restart until setup is done;
there are no default credentials. The same can be done with the API:

```bash
curl -X POST http://127.0.0.1:8080/api/v1/setup -H 'content-type: application/json' \
  -d '{"token":"<from log>","username":"admin","password":"a long passphrase"}'
```

Further accounts are created by an administrator (`POST /api/v1/users`); there is no open sign-up.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | — (required) | Database password. |
| `PUBLIC_ORIGIN` | empty | Public URL, e.g. `https://notes.example.com`. Enables strict `Origin` checks for browser requests. Set it in production. |
| `COOKIE_SECURE` | `true` | Secure `__Host-` session cookie. Set `false` only for plain-HTTP tests. |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting. Enable only behind your own proxy. |
| `BIND_HOST` / `HTTP_PORT` | `127.0.0.1` / `8080` | Published address. Keep localhost and put a TLS proxy in front. |
| `MAX_DOCUMENT_BYTES` | 16 MiB | Maximum document size. |
| `SESSION_TTL_DAYS` | 30 | Session lifetime. |

Migrations run automatically at startup. If one fails, the server exits instead of serving with a
partial schema; `restart: unless-stopped` then retries.

## HTTPS reverse proxy

Caddy (automatic certificates):

```
notes.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;
    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Traefik: route `Host(\`notes.example.com\`)` to the `server` service on port 8080 with a TLS
certresolver. With any proxy set `PUBLIC_ORIGIN` and `TRUST_PROXY=true`.

## Backup and restore

All data is in PostgreSQL (documents are stored in the `blobs` table).

```bash
# Backup
docker compose exec -T db pg_dump -U mdreader -Fc mdreader > mdreader-$(date +%F).dump
# Restore into an empty database
docker compose exec -T db pg_restore -U mdreader -d mdreader --clean --if-exists < mdreader-2026-11-07.dump
```

Test restores regularly. Attachments will be stored on a volume once implemented; this section
will then cover them too.

## Upgrades

```bash
git pull
docker compose up -d --build
```

The new server applies pending migrations at startup. Take a backup first.
