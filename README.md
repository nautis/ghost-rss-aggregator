# Ghost RSS Aggregator

Fetches RSS / Atom feeds from third-party publications and posts them to a Ghost CMS instance. Runs as a long-lived daemon with cron-based scheduling, or one-shot from the CLI. Originally written to aggregate watch-industry feeds onto [tellingtime.com](https://tellingtime.com).

## Setup

Requires **Node ≥ 20**.

```bash
git clone https://github.com/nautis/ghost-rss-aggregator.git
cd ghost-rss-aggregator
cp env-template .env    # edit with your Ghost credentials
npm install
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GHOST_URL` | Yes | Ghost site URL |
| `GHOST_ADMIN_API_KEY` | Yes | Admin API key (`key-id:secret`) |
| `DB_PATH` | No | SQLite path (default: `./data/aggregator.db`) |
| `FETCH_INTERVAL` | No | Cron schedule (default: `*/30 * * * *`) |

## Usage

```bash
# Manage feeds
node src/cli.js add -n "Hodinkee" -u "https://www.hodinkee.com/articles/rss.xml"
node src/cli.js list
node src/cli.js remove <id>
node src/cli.js toggle <id>

# Fetch manually
node src/cli.js fetch              # all active feeds
node src/cli.js fetch -f <id>      # single feed

# Monitor
node src/cli.js logs
node src/cli.js stats

# Run as daemon (every 30 min by default)
node src/cli.js daemon
```

### Optional `add` flags

| Flag | Default | Description |
|------|---------|-------------|
| `-t, --tag <slug>` | `news` | Tag to apply to imported posts |
| `-s, --status <state>` | `draft` | `draft` or `published` |
| `-k, --keywords <list>` | none | Comma-separated keyword filter — items must contain at least one |

### systemd service

```ini
[Unit]
Description=Ghost RSS Aggregator
After=network.target

[Service]
Type=simple
User=matt
WorkingDirectory=/opt/ghost-rss-aggregator
EnvironmentFile=/opt/ghost-rss-aggregator/.env
ExecStart=/usr/bin/node src/cli.js daemon
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

> **`.env` quirk:** `FETCH_INTERVAL` contains spaces (`*/30 * * * *`). systemd's `EnvironmentFile` parses it correctly, but if you ever source the file from bash for one-off CLI commands, exclude that line: `env $(grep -v FETCH_INTERVAL .env | xargs) node src/cli.js list`.

## How it works

1. Each cycle fetches up to 10 most-recent items per feed.
2. Deduplicates by normalized URL against the local SQLite DB (`imported_items`).
3. Extracts a feature image from `media:thumbnail`, `media:content`, `enclosure`, the first `<img>` in body HTML, or a YouTube video thumbnail.
4. Downloads the image, validates it's actually an image (magic-byte sniff), and uploads it to Ghost.
5. Creates a Ghost post (draft by default; `published` if the feed is configured for it) with source attribution tags.
6. Logs the cycle to `fetch_logs` for auditing (`node src/cli.js logs`).

The scheduler skips ticks that overlap with a still-running cycle, so a slow feed can't compound into back-to-back fetches.

## Security

The aggregator pulls untrusted content (RSS bodies, feed-supplied URLs, remote images) and writes to a privileged Ghost API. The hardening below is what makes that combination safe.

### SSRF protection

- **URL allowlist** rejects non-`http(s)` schemes and private IPs across IPv4 *and* IPv6: `127.0.0.0/8`, RFC1918, link-local (`169.254.0.0/16`, `fe80::/10`), unique-local (`fc00::/7`), CGNAT, multicast, cloud metadata (`169.254.169.254`, `metadata.google.internal`, etc.), IPv4-mapped IPv6 (`::ffff:127.0.0.1` in both dotted-quad and compressed-hex form). See `src/utils/url-validator.js`.
- **DNS resolution** via `dns.lookup({ all: true })` checks every returned address against the blocklist before any request fires. Closes the rebinding hole that hostname-only validators leave open (e.g. `attacker.com → 127.0.0.1`).
- **IP pinning** via curl `--resolve <host>:<port>:<ip>` for feed fetches uses the validated address, closing the TOCTOU window where DNS could change between check and connect.
- **Manual redirect handling** — curl is invoked with `--max-redirs 0` and feed/image fetches follow up to 3 hops in JS, revalidating each hop. Without this, a whitelisted feed could 301 to `169.254.169.254` and curl `-L` would happily follow.

### Image fetch hardening

- **Streamed download** with a running size cap (`maxImageSize`, default 5MB). Bodies are aborted mid-flight if a server lies about `Content-Length`.
- **Magic-byte sniff** — only JPEG/PNG/GIF/WEBP signatures pass. `Content-Type` from the remote server is not trusted.
- **SVG rejected** at both the `Content-Type` and content-sniff layer (Ghost serves `image/svg+xml` verbatim, which makes SVG a stored-XSS vector).

### Other

- **HTML excerpt escape** before insertion into the Ghost post body.
- **Canonical URL scheme check** — `item.link` from a feed is validated as `http(s):` before being passed to Ghost.
- **Filename sanitization** on multipart uploads (no header injection or path traversal).
- **JWT** with 5-minute expiry, hex-decoded secret, `aud=/admin/`.
- **Ghost API timeouts**: 30s on JSON requests, 60s on image uploads.
- **No raw secrets in repo** — `.env` is gitignored; `env-template` ships placeholders only.

### Operational

- **SQLite WAL mode** (`journal_mode=WAL`, `synchronous=NORMAL`) — concurrent CLI readers (`logs`/`stats`/`list`) don't block the daemon's writes.
- When snapshotting the DB, copy all three files: `aggregator.db`, `aggregator.db-wal`, `aggregator.db-shm`. Or use `sqlite3 source.db ".backup target.db"`.

## License

MIT
