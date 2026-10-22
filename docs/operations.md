# Operating DealSaathi (hosted on Embarko)

Settings are environment variables on the Embarko app (Embarko → the app → Environment). Values are write-only.

| Variable | Purpose |
| --- | --- |
| `APP_PASSWORD` | Team access code; needed to register as an **agent** (buyers and sellers sign up openly) |
| `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SECRET` | viaSocket embed credentials |
| `CRON_SECRET` | Set by Embarko for the 15-minute schedule (`/tasks/automations`) |
| `SYSTEM_MAIL_CONNECTION` | Turns on verification and password-reset emails (see below) |
| `BACKUP_TOKEN` | At least 32 random characters; allows downloading backups off the host |
| `RESTORE_FROM` | Only while restoring (see below); remove it afterwards |
| `RAZORPAY_LIVE` | Leave **unset** until a real Razorpay payment-link test has passed |

## Email (verification and password reset)

1. Sign in as an agent on the live app, open **Integrations**, connect the Gmail account DealSaathi should send from
   (a shared mailbox such as `no-reply@…` is best), and press **Check access**, then **Send test**.
2. Note that account's number, shown as `connection #N` under it on **Integrations**. Set `SYSTEM_MAIL_CONNECTION=N`
   and redeploy (or apply env vars).
3. The start-up log then says `System email: on`. Without it, the app says verification and reset are unavailable;
   it never pretends to send.

## Backups

- A verified copy is made at start-up (if the newest is over a day old) and every day by the 15-minute schedule:
  `DATA_DIR/backups/dealsaathi-<UTC time>.db`. Each is checked (integrity check, schema, row counts, SHA-256) before it
  counts. The newest 7 plus one per week for 4 weeks are kept. The schedule's answer ends with the backup state.
- Each migration also leaves `DATA_DIR/dealsaathi.db.pre-v<N>-<time>.bak`.
- These copies sit on the same host as the database. **Copy them off the host** regularly:

  ```bash
  curl -fsS -H "Authorization: Bearer $BACKUP_TOKEN" -o dealsaathi-latest.db \
       -D headers.txt https://dealsaathi-app.embarko.app/tasks/backups/latest
  grep -i x-backup-sha256 headers.txt; sha256sum dealsaathi-latest.db      # must match
  curl -fsS -H "Authorization: Bearer $BACKUP_TOKEN" https://dealsaathi-app.embarko.app/tasks/backups   # list
  ```

## Restore (tested: `test/backup.test.js`, and through a real start-up on a copy)

1. Pick the backup: `GET /tasks/backups` lists them (`file`, `created_at`, row counts).
2. Set `RESTORE_FROM=dealsaathi-<time>.db` and redeploy.
3. Start-up verifies the backup, copies the current data to `dealsaathi.db.pre-restore-<time>.bak`, then replaces the
   tables inside the same database file in one transaction. A bad or missing backup changes nothing and the log says
   `NOT restored`.
4. Check the log line `[restore] Restored …` and the counts, then **remove `RESTORE_FROM`**. (If left, later restarts
   skip it: `already restored`.)
5. To undo a restore, restore from the `pre-restore` copy the same way after copying it into `backups/` under a
   `dealsaathi-<time>.db` name.

## Rolling back a release

- Code: Embarko keeps the last 5 builds: `POST https://ship.embarko.ai/api/apps/dealsaathi-app/rollback` (or the
  dashboard). Data is not rolled back; migrations only add tables and columns, and the previous release
  (`ae78f53`) was checked to start and serve on a v7 database.
- Note: rolling back to `ae78f53` brings back its weaker tenancy linking (by unverified email). Prefer fixing forward.
- Data: restore a backup as above.

## Rotating credentials

Neither provider offers revocation through an API today, so this needs the owner:

- **viaSocket embed secret:** viaSocket's API only returns the current secret (no regenerate endpoint; reported to
  viaSocket). Ask viaSocket support, or use the dashboard if it offers it, to regenerate it. Then set
  `VIASOCKET_EMBED_SECRET` on Embarko and in your local `.env`, redeploy, and check the start-up log
  (`viaSocket: configured`) and that **Integrations** loads. Everyone keeps their connections (they belong to user
  ids, not to the secret).
- **Embarko deploy token:** request a new one (`POST https://ship.embarko.ai/api/public/deploy-tokens/request`
  with your email; it arrives by email). Embarko says existing tokens keep working, so ask Embarko support (or the
  dashboard) to revoke the old one. Replace it in `~/.embarko/credentials`, then check with
  `GET https://ship.embarko.ai/apps/dealsaathi-app/status`.
- **`APP_PASSWORD`, `CRON_SECRET`:** change on Embarko; `CRON_SECRET` is managed by Embarko.

## Real-service checks

On the live app, as an agent: **Integrations → Send test** sends one email to your own address, posts one Slack
message to the channel you pick, or creates and deletes one calendar event. The provider's own id is shown and kept
(Deliveries, and the connection's "access check" line). These are the only results to count as real.
