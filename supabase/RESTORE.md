# Restoring a Supabase backup

Remember first: every friend's computer has a full copy of their own data.
If Supabase loses everything, signing in again and syncing puts each
person's data back. These backups are for when that is not enough, for
example a friend lost their computer *and* the Supabase data is gone.

## 1. Download and open a backup

GitHub → this repository → **Actions** → **Database backup** → pick a night →
download the `muhurata-backup-…` file under *Artifacts* and unzip it. Then:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in muhurata-backup-2026-10-19.tar.enc -out backup.tar
tar -xf backup.tar
```

It asks for the `BACKUP_PASSPHRASE`. You get `data.dump` (all the tables)
and `users.csv` (each account's id and email).

## 2. Put it back

`$SUPABASE_DB_URL` is the project's *Session pooler* connection string
(Supabase → **Connect**), which logs in as the `postgres` user. That user
owns the tables, so the own-rows-only rules do not block the restore.

**Into the same project** (the accounts still exist, the data is damaged):

```bash
pg_restore --data-only --no-owner -d "$SUPABASE_DB_URL" data.dump
```

Empty the four tables first if they still hold damaged rows
(`truncate activity_segments, custom_presets, app_settings, focus_by_device;`
in the SQL Editor).

**Into a brand-new project** (the old one is gone):

1. Run `supabase/schema.sql` in the new project's SQL Editor.
2. Recreate the accounts with their old ids, so the data still belongs to
   the right people. In the SQL Editor, for each row of `users.csv`:
   `insert into auth.users (id, email, aud, role) values ('<id>', '<email>', 'authenticated', 'authenticated');`
   Friends then sign in with an email code as usual; there are no passwords
   to restore.
3. Run the `pg_restore` line above against the new project.
4. Put the new project's URL and key into the app and release it.
