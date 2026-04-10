# Ghost RSS Aggregator

Fetches RSS feeds from watch publications and posts them to Ghost CMS as drafts. Runs as a systemd daemon with cron-based scheduling.

## Setup

```bash
git clone https://github.com/nautis/ghost-rss-aggregator.git
cd ghost-rss-aggregator
cp env-template .env    # Edit with your Ghost credentials
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
node src/cli.js fetch              # All active feeds
node src/cli.js fetch -f <id>      # Single feed

# Monitor
node src/cli.js logs
node src/cli.js stats

# Run as daemon (every 30 min by default)
node src/cli.js daemon
```

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

## How it works

1. Fetches up to 10 items per feed per cycle
2. Deduplicates by URL (normalized) and title against both local DB and Ghost
3. Uploads featured images to Ghost (extracts from media:thumbnail, media:content, enclosure, HTML, or YouTube)
4. Creates draft posts with source attribution tags
5. Logs each fetch cycle to SQLite for auditing

## Security

- SSRF protection on feed and image URLs (blocks private IPs, cloud metadata, localhost)
- HTML sanitization on excerpts
- Filename sanitization on image uploads
- JWT auth with 5-minute token expiry

## License

MIT
