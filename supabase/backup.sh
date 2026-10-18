#!/usr/bin/env bash
# Make an encrypted copy of everything in the Supabase database.
#
#   SUPABASE_DB_URL=... BACKUP_PASSPHRASE=... supabase/backup.sh <output-dir>
#
# Run every night by .github/workflows/backup.yml. Writes one file,
# muhurata-backup-<date>.tar.enc, holding:
#   data.dump  every table in the public schema (pg_dump custom format)
#   users.csv  each account's id and email, so the data can be matched back
#              to the right people if it ever has to go into a new project
#
# The repository is public, so the file is encrypted (AES-256, key derived
# from BACKUP_PASSPHRASE). supabase/RESTORE.md explains how to open it.
set -euo pipefail

OUT_DIR="${1:?output dir required}"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is not set}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stamp="$(date -u +%Y-%m-%d)"
mkdir -p "$OUT_DIR"

pg_dump "$SUPABASE_DB_URL" --schema=public --format=custom --no-owner --no-privileges \
    --file="$work/data.dump"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q \
    -c "\copy (select id, email, created_at from auth.users order by created_at) to '$work/users.csv' csv header"

# Prove the dump is readable before calling the backup good.
pg_restore --list "$work/data.dump" > /dev/null

tar -C "$work" -cf "$work/backup.tar" data.dump users.csv
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
    -pass env:BACKUP_PASSPHRASE -in "$work/backup.tar" -out "$OUT_DIR/muhurata-backup-$stamp.tar.enc"

echo "Backed up $(($(wc -l < "$work/users.csv") - 1)) accounts to muhurata-backup-$stamp.tar.enc" \
     "($(du -h "$OUT_DIR/muhurata-backup-$stamp.tar.enc" | cut -f1))"
