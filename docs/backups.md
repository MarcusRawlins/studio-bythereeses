# Reese Photography CRM Backups

This CRM uses Cloudflare D1/R2 in production, but operational backups live on `reeseai-memory` so the project is not dependent on Cloudflare as the only copy.

## What Gets Backed Up

- Code mirror: `/Volumes/reeseai-memory/code/reese-photography-crm`
- Local SQLite dev database snapshots: `/Volumes/reeseai-memory/backups/reese-photography-crm/sqlite`
- Cloudflare D1 production SQL exports: `/Volumes/reeseai-memory/backups/reese-photography-crm/d1`
- Backup manifests: `/Volumes/reeseai-memory/backups/reese-photography-crm/manifests`
- Weekly reconciliation reports: `/Volumes/reeseai-memory/backups/reese-photography-crm/reconciliations`
- Backup run logs: `/Volumes/reeseai-memory/backups/reese-photography-crm/logs`
- LaunchAgent stdout/stderr logs: `~/Library/Logs/reese-photography-crm`

The code mirror is intentionally non-destructive. It does not use `--delete`, so a bad local state cannot erase the archive mirror in one run.

## Schedule

- Daily backup: 2:15 AM local time.
- Weekly reconciliation: Monday at 3:15 AM local time.

Install or refresh the schedule:

```bash
npm run backup:install-launchd
```

Run manually:

```bash
npm run backup:daily
npm run backup:reconcile
```

## Cloudflare Token

The D1 export needs a Cloudflare API token. Do not commit it to the repo or write it into Obsidian.

Preferred local setup is macOS Keychain:

```bash
read -s CF_TOKEN
security add-generic-password -a "$USER" -s reese-crm-cloudflare-api-token -U -w "$CF_TOKEN"
unset CF_TOKEN
```

The backup script also supports a one-off shell env var:

```bash
CLOUDFLARE_API_TOKEN="..." npm run backup:daily
```

Or a private local file at `~/.reese-crm-backup.env`:

```bash
chmod 600 ~/.reese-crm-backup.env
```

with:

```text
CLOUDFLARE_API_TOKEN=...
```

## Reconciliation Expectations

The weekly report checks:

- Code mirror exists.
- Mirror git HEAD matches local git HEAD.
- Latest local SQLite backup exists.
- Latest Cloudflare D1 export exists.
- Latest Cloudflare D1 export is current. If the export is present but older than 36 hours, the report warns so production data backup drift is visible.
- A recent backup manifest exists.

If any critical item fails, the reconciliation exits non-zero and writes the report for review.
