#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
BACKUP_ROOT="/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm"
SQLITE_DIR="$BACKUP_ROOT/sqlite"
D1_DIR="$BACKUP_ROOT/d1"

mkdir -p "$SQLITE_DIR" "$D1_DIR"

DATABASE_PATH="${DATABASE_PATH:-$ROOT_DIR/data/local.db}" SQLITE_DIR="$SQLITE_DIR" STAMP="$STAMP" node <<'NODE'
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

const src = process.env.DATABASE_PATH;
const destDir = process.env.SQLITE_DIR;
const stamp = process.env.STAMP;

if (!fs.existsSync(src)) {
  console.log(`Local SQLite database not found at ${src}; skipping local DB backup.`);
  process.exit(0);
}

const db = new Database(src);
db.pragma("wal_checkpoint(TRUNCATE)");
const dest = path.join(destDir, `local-${stamp}.db`);
db.backup(dest).then(() => {
  fs.copyFileSync(dest, path.join(destDir, "latest.db"));
  console.log(`Local SQLite backup written to ${dest}`);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  npx wrangler d1 export studio-bythereeses \
    --remote \
    --output "$D1_DIR/studio-bythereeses-$STAMP.sql" \
    --skip-confirmation
  cp "$D1_DIR/studio-bythereeses-$STAMP.sql" "$D1_DIR/latest.sql"
  echo "Cloudflare D1 backup written to $D1_DIR/studio-bythereeses-$STAMP.sql"
else
  echo "CLOUDFLARE_API_TOKEN is not set; skipping remote D1 export."
fi
