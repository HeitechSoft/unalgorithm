# Run your own UnAlgorithm Feed server

This guide takes you from a fresh Linux server to your own UnAlgorithm server: HTTPS, you as its admin, the people you
invite, daily limits, nightly encrypted backups, and a restore after losing the machine. Every command below is meant
to be copied as it is. Replace only these placeholders: `<version>` (a server release, such as `0.1.0`), `<file>` (a
backup file's name), `you@example.org` (your email address and your login on the server) and
`unalgorithm.example.org` (your server's domain name).

## What you get

Your server is what the UnAlgorithm Feed extension signs in to instead of using an API key in each browser:

- **AI labels without an API key in each browser.** The extension sends posts to your server, and your server asks the
  AI: Anthropic with your key, or a local model with Ollama (then posts never leave your machine).
- **Invites.** Only the people you invite can create an account.
- **A daily post cap per person**, and a daily AI spend limit for the whole server.
- **An admin page** in the browser for accounts, invites, limits, usage and the server's health.
- **Nightly encrypted backups**, encrypted to a key only you hold.
- **Alerts** by email or webhook when the disk fills up, errors pile up, the spend limit is reached or a backup fails.

Running your own server is free: the server is open source. Whoever runs it pays its AI bill, or runs a local model with
Ollama and pays nothing per post.

## What you need

- **A Linux VPS** with Ubuntu 24.04 LTS or Debian 13. These are recommendations, not hard limits:
  - without Ollama: 2 vCPUs, 2 GB of RAM and 20 GB of disk;
  - with Ollama and a 3B model: 8 GB of RAM or more and about 40 GB of disk, since the Ollama image and each model
    take several GB.
- **A domain name** you can add DNS records to, such as `unalgorithm.example.org`.
- **Ports 80 and 443** open to the internet (check your provider's firewall too).
- **An SMTP account** for the sign-in codes the server emails, from your mail provider.
- **An Anthropic API key**, or Ollama on the same machine (section 6).

## 1. Install Docker

Install Docker Engine with the Compose plugin by following [Docker's own instructions](https://docs.docker.com/engine/install/)
for your distribution. Then check the Compose version:

```bash
docker compose version
```

It must print v2 or later (current Docker prints v5). The old `docker-compose` v1 command, with a hyphen, does not work
with this guide.

Decide which account runs Docker: either log in as root, or add your own user to the `docker` group as Docker's
[Linux post-install steps](https://docs.docker.com/engine/install/linux-postinstall/) describe. Membership in that group
equals root on the machine, just as running commands in the server's container makes you its admin (section 7). Log out
and in again, then check that Docker works without `sudo`:

```bash
docker run --rm hello-world
```

Every command below, and the `ssh` one-liners in sections 10 and 11, run plain `docker compose` without `sudo`.

## 2. Get the server files

Find the newest server release on the [releases page](https://github.com/HeitechSoft/unalgorithm/releases): its tag is
`server-v<version>` and its title reads "UnAlgorithm Feed server <version>". Get its files in your home folder (the
`ssh` one-liners in sections 10 and 11 expect `~/unalgorithm`):

```bash
cd ~
git clone --depth 1 --branch server-v<version> https://github.com/HeitechSoft/unalgorithm.git
cd unalgorithm/apps/server
```

Everything below runs in that folder, `~/unalgorithm/apps/server`, unless it says "from your computer".

## 3. Configure

Make your settings file and keep it private:

```bash
cp .env.example .env && chmod 600 .env
```

`.env.example` explains every setting. Open `.env` in an editor and set these (to set a commented line, remove the `#`
in front of it):

```ini
UNALGORITHM_VERSION=<version>
PUBLIC_URL=https://unalgorithm.example.org
INSTANCE_NAME=
BETTER_AUTH_SECRET=
POSTGRES_PASSWORD=
COMPOSE_PROFILES=caddy
TRUST_PROXY=one-hop
```

- `UNALGORITHM_VERSION` pins the release you cloned; you change it when you upgrade (section 13).
- `INSTANCE_NAME`: your server's name, which people see on the sign-in page and in the extension. The
  [Naming](#naming) section says which name not to use.
- `BETTER_AUTH_SECRET`: paste the output of `openssl rand -base64 48`.
- `POSTGRES_PASSWORD`: paste the output of `openssl rand -hex 32`.
- `COMPOSE_PROFILES=caddy` turns on Caddy, which gets the HTTPS certificate for you; with Ollama on the same machine,
  write `COMPOSE_PROFILES=caddy,ollama`. Keep `TRUST_PROXY=one-hop` with Caddy. To use your own HTTPS proxy instead,
  read [Using your own HTTPS proxy](#using-your-own-https-proxy).

Mail, for the sign-in codes, from your mail provider:

```ini
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=starttls
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=
```

- `SMTP_HOST`: your provider's SMTP server. Keep port 587 with `starttls`, or use 465 with `tls` if your provider says
  so.
- `SMTP_USER` and `SMTP_PASSWORD`: your SMTP login. Put a value that contains `$` in single quotes.
- `MAIL_FROM`: the address the sign-in codes come from, one your provider lets you send as.

The AI, with Anthropic:

```ini
AI_PROVIDER=anthropic
AI_API_KEY=
```

Put your Anthropic API key after `AI_API_KEY=`.

Or with Ollama on the same machine (and `ollama` in `COMPOSE_PROFILES`), leaving `AI_API_KEY` empty:

```ini
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://ollama:11434/v1
AI_MODEL=llama3.2:3b
AI_DATA_POLICY=self-hosted
```

`SIGNUP_ALLOWLIST` can stay empty: people join through the invites you make on the admin page (section 8).

To let anyone join, set `SIGNUP=open`: every address its provider verified (an emailed code, or Google's
`email_verified`) can create an account, with no allowlist or invite. `SIGNUP=open` lets anyone with a verified address
create an account and use this server's AI at your cost. Use it with a billing module, or keep per-user caps
(`USER_DAILY_POST_CAP`) and the daily spend limit (`DAILY_SPEND_LIMIT_USD`) low. Each address is sent at most 5 sign-in
codes at once, then one every 12 minutes, whoever asks, so the server cannot be used to flood someone's mailbox.

Optional: sign in with Google, besides email codes. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` together, as the
comment above them in `.env.example` says; it also gives the redirect address to register with Google
(`https://unalgorithm.example.org/api/auth/callback/google`). Leave both unset to keep email codes only.

Check the settings without starting anything. The check prints the names of settings that are missing or wrong, never
their values:

```bash
docker compose run --rm --no-deps server node apps/server/src/cli/check-config.ts
```

Keep a copy of `.env` somewhere safe, off this machine, such as a password manager. A restore needs the same
`BETTER_AUTH_SECRET` (section 11).

## 4. Point your domain at the server

At your DNS provider, add an A record for the host in `PUBLIC_URL` (`unalgorithm.example.org`) with your VPS's IPv4
address, and an AAAA record with its IPv6 address if it has one. Wait until the name resolves to your server, for
example with `getent hosts unalgorithm.example.org` on the server. Caddy then gets the certificate by itself when the
server starts.

Caddy keeps its certificates in the `caddy-data` volume. Keep it: stop with `docker compose down`, never
`docker compose down -v`, or every start asks Let's Encrypt for a new certificate and its
[rate limits](https://letsencrypt.org/docs/rate-limits/) can lock you out for days.

## 5. Start

```bash
docker compose pull
docker compose up -d --wait
```

The server applies its database migrations by itself. Check it from anywhere:

```bash
curl -fsS https://unalgorithm.example.org/health
```

It prints `"ok":true` and the version. Until you become the admin (section 7), the server's log shows a `setup.needed`
line:

```bash
docker compose logs server
```

Until you make the backup key (section 10), the backup reports `no-key` and its alert is open. That is expected:
section 10's first backup closes it.

## 6. Turn on AI

With Ollama only, download the model first:

```bash
docker compose exec ollama ollama pull llama3.2:3b
```

The `compose.yaml` here runs Ollama on the CPU. For a GPU, follow [Ollama's own Docker instructions](https://hub.docker.com/r/ollama/ollama)
in a `compose.override.yaml` next to `compose.yaml`, which Compose [merges by itself](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/);
that file is specific to your machine and stays out of this guide.

Then, for either provider, run the eval: it classifies a fixed set of example posts and compares the answers with the
expected ones. The server serves AI labels only once it prints `PASSED`. With Anthropic it costs a few cents.

```bash
docker compose exec server node apps/server/src/cli/route-eval.ts
```

If a local model does not pass, try a larger one. These are the extension's own Ollama choices
(`COMPAT_PREFERENCES.ollama` in [models.ts](../packages/ai/src/models.ts)), in this order: `llama3.2:3b`,
`qwen2.5:7b`, `gemma3:4b`, `llama3.1:8b`. Pull the next one with the command above and its name, set `AI_MODEL` in
`.env` to it, run `docker compose up -d --wait`, then the eval again. Or lower `ROUTE_EVAL_MIN_AGREEMENT` in `.env`, knowing that labels
will be less accurate.

Run `route-eval` again whenever a release's notes say the classification prompt changed.

### Fact-check (Labs)

Fact-check is a Labs feature, off by default. Once on, people can ask your server to check the claims in a public post:
it searches the web for each claim, writes a verdict with its sources, and checks that the source links answer. It works
on public posts only, on every site the extension supports.

It needs a way to search the web. With Anthropic, your server uses Anthropic's web search on your API key:

```ini
FACTCHECK=on
```

Or, with any AI provider, a search engine. With the local model from above, SearXNG on the same machine keeps it free:
add `searxng` to `COMPOSE_PROFILES` (for example `caddy,ollama,searxng`) and set

```ini
FACTCHECK=on
SEARCH_PROVIDER=searxng
SEARCH_URL=http://searxng:8080
SEARXNG_SECRET=
```

with the output of `openssl rand -hex 32` after `SEARXNG_SECRET=`. Your own SearXNG elsewhere works too: put its address
in `SEARCH_URL`. Or use `SEARCH_PROVIDER=brave` or `tavily` with that service's API key in `SEARCH_API_KEY`. An
OpenAI-compatible model always needs `SEARCH_PROVIDER`; `.env.example` explains `AI_RESEARCH_MODEL` and
`AI_SYNTHESIS_MODEL` if you want other models than the defaults. A server that charges for checks (`BILLING=module`)
researches with Anthropic's web search only.

Run `docker compose up -d --wait`, then open the gate the same way as for classification: the fact-check eval runs 24
checks and the server offers fact-check only once it prints `PASSED`. It costs about $3 with Anthropic, nothing on your own
hardware.

```bash
docker compose exec server node apps/server/src/cli/route-eval.ts factcheck
```

Each person may run `USER_DAILY_CHECK_CAP` checks per UTC day, 10 unless you change it (0 allows none), and checks count
toward the `DAILY_SPEND_LIMIT_USD` spend breaker like classification does (section 8).

Your server keeps a claim cache, on unless you set `CLAIM_CACHE=off`. When a claim was settled by two independent
sources in a check of a public post, a later check of the same claim on your server, by anyone, still asks the model for
the post's claims, then shows the kept verdict and explanation instead of searching and judging again, marked with the
hour it was first checked. It costs that one claims call, and on a server that charges, the price is that call's cost
times the usual multiplier. A row in the `claim_cache` table holds a keyed hash of the normalized claim (under a key
derived from `BETTER_AUTH_SECRET`), the verdict, the model's short explanation (unless it repeats six or more words of
the post in a row), up to four public source addresses with their titles and short quotes, and two times to the hour;
never the claim, the post's text, who checked, or a source on Facebook or LinkedIn. Rows expire after 24 hours and an
hourly job deletes them. The cache belongs to your server alone and is never sent to another one. A check served from it
still counts toward `USER_DAILY_CHECK_CAP`.

What leaves your server: the claims, worded from public posts, go to your search provider, or to Anthropic with its web
search. SearXNG sends them on to the search engines it asks, from this machine's IP address. The source links in a
verdict are checked from your server, never from people's browsers, and only for their status.

That link check never reaches private or local addresses, nor the addresses `PUBLIC_URL`'s host resolves to. Add any
other address it must never reach to `EGRESS_DENY`, as IPs or ip/prefix ranges, comma-separated. In particular, list this
machine's own public addresses whenever `PUBLIC_URL` does not resolve to them: a CDN or another proxy in front, a second
IPv4 address, or the rest of its IPv6 /64.

### Other perspectives (Labs)

Other perspectives is a Labs feature, off by default. Once on, people can ask your server how other outlets covered the
story behind a link shared in a public post. It runs on the fact-check routes and search, so it needs fact-check on and
past its eval gate:

```ini
FACTCHECK=on
PERSPECTIVES=on
```

It stays unavailable until a reviewed outlet registry ships with a release, whatever this setting says. Checks and
comparisons share `USER_DAILY_CHECK_CAP`: each person may run that many of the two together per UTC day.

What leaves your server: only the shared link and its title leave people's browsers, never the post's text. Your server
follows the link's redirects through the same guarded fetcher as the link check, and its search queries go to your
search provider, or to Anthropic with its web search.

## 7. Become the admin

Make a setup link for your own address:

```bash
docker compose exec server node apps/server/src/cli/setup-link.ts you@example.org
```

Open the link it prints within 60 minutes and sign in with that address: you are now the server's admin, and the admin
page is at `https://unalgorithm.example.org/admin`.

- One link works at a time, only for that address, and only while the server has no admin. Making a new one replaces
  the unused one.
- Later, to make another admin with a link (for example, when the only admin lost their mailbox), add `--recover`.
  Whoever can run commands in the server's container controls the server anyway.
- A link for the address of an account whose access an admin removed lifts that removal at once, so the person can sign
  in on `/setup` to claim it. The command then prints a third line: "This address's account had been removed from this
  server; it can sign in again."

## 8. Invite people and set limits

Everything here happens on the admin page, `https://unalgorithm.example.org/admin`.

- **Invite someone:** enter their address and choose Invite. The server sends no email: the page shows a sentence to
  pass on, such as "Tell you@example.org: install UnAlgorithm Feed, open Settings, then AI, choose a server, enter
  https://unalgorithm.example.org, and sign in with this address." Pass on section 9's step with it: until a store
  build carries the server card, the person needs the `UA_CLOUD=1` build from the same release and must send you its
  id, which you add to `EXTENSION_IDS`.
- **Remove an invite** that is still pending, from the list of pending invites.
- **Daily posts per person:** choose a person to set their own daily post cap, or use the server's
  (`USER_DAILY_POST_CAP`, 1,000 by default, in `.env`).
- **Daily AI spend:** the whole server's limit (`DAILY_SPEND_LIMIT_USD`, $5 by default, in `.env`). At the limit, AI
  pauses for everyone until 00:00 UTC; the page shows today's cost against it.
- **Access:** remove someone's access (they are signed out on every device and cannot sign in) or restore it.
- **Role:** make another admin, or make an admin a regular user again.

After changing a value in `.env`, run `docker compose up -d` to apply it.

## 9. Connect the extension

In the extension: Settings → AI → UnAlgorithm server → enter `https://unalgorithm.example.org` → sign in with the code
emailed to you.

The current limit, plainly: the version of UnAlgorithm Feed in the Chrome Web Store gets this option only with the
release described in [docs/release.md](release.md#before-a-store-build-carries-the-cloud-card) ("Before a store build
carries the Cloud card"). Until then, every person who signs in to your server (you, the admin, and each person you
invite) needs the extension built from the same release with `UA_CLOUD=1`, on their own computer, and loaded unpacked.
Building needs Node and pnpm, as [CONTRIBUTING.md](../CONTRIBUTING.md#set-up) describes; on Windows, run these in Git
Bash or WSL:

```bash
git clone --depth 1 --branch server-v<version> https://github.com/HeitechSoft/unalgorithm.git
cd unalgorithm
pnpm install
UA_CLOUD=1 pnpm zip
```

Then open `chrome://extensions`, turn on Developer mode, choose Load unpacked and select
`apps/extension/.output/chrome-mv3` (or an unzipped copy of it).

An unpacked build's id comes from its folder, so each person's browser has its own id, and the id changes if the folder
moves. Each person sends you their id (on `chrome://extensions`, the extension's Details). Add all of them to
`EXTENSION_IDS` in `.env`, comma-separated, then apply it:

```bash
docker compose up -d
```

Setting `EXTENSION_IDS` replaces the ids the server accepts by default, so list every id, yours included.

## 10. Backups

What runs by itself: the `backup` service dumps the database every night at 03:17 UTC, with the newest 14 kept in
`backups/` next to `compose.yaml`, each encrypted to a key only you hold. Docker creates `backups/` and `backup-key/`
(owned by root) on the first start; don't create them yourself. The time, the number kept and the folder are settings in
`.env` (`BACKUP_TIME`, `BACKUP_KEEP`, `BACKUP_DIR`).

The commands below that say "from your computer" run on your own computer, not on the server, in a POSIX shell: a
macOS or Linux terminal, or WSL or Git Bash on Windows. PowerShell's redirection does not work for them.

**Make the key once, from your computer**, so the private key never lands on the server. The `keygen` service is the
only one that may write `backup-key/`, and it logs nothing, so the private key reaches no log file on the server:

```bash
ssh you@unalgorithm.example.org 'cd unalgorithm/apps/server && docker compose run --rm --no-deps -T keygen' > backup-private-key.asc
```

Keep `backup-private-key.asc` in a password manager and in a second place. Without it no backup can be restored.

To replace the key later, run the same line with `keygen --replace` and a new file name
(`docker compose run --rm --no-deps -T keygen --replace`). Backups made before then still need the old private key.

Keep the public key, `backup-key/backup-public-key.asc`, with your saved `.env` (it is public, and a restore puts it
back). From your computer:

```bash
scp you@unalgorithm.example.org:unalgorithm/apps/server/backup-key/backup-public-key.asc .
```

**Take a backup now**, on the server:

```bash
docker compose exec backup bash /scripts/backup.sh --once
```

It prints a `backup.done` line whose `file` is the backup's name: that is `<file>` below. Right after it, prove that
your saved private key opens it, from your computer:

```bash
ssh you@unalgorithm.example.org 'cd unalgorithm/apps/server && docker compose run --rm -T backup bash /scripts/restore.sh --check /backups/<file>' < backup-private-key.asc
```

It must log `restore.checked`. The check decrypts the whole backup and changes nothing.

**Copy the folder off the box every day**: a backup on the same disk dies with it. The files are encrypted, so any
storage will do. For example, from your computer:

```bash
rsync -a --exclude '.partial-*' you@unalgorithm.example.org:unalgorithm/apps/server/backups/ ~/unalgorithm-backups/
```

The admin page shows the last backup, and a failed or missing one opens an alert (section 12).

## 11. Restore after losing the server

On a new VPS, follow sections 1 to 4 with your saved `.env` in place of a new one (the same `BETTER_AUTH_SECRET` and
`POSTGRES_PASSWORD`), and point the domain at the new machine.

Put the saved public key back through the `keygen` service, the only one whose `/keys` is writable (Docker creates
`backup-key/` as root, and the `backup` service mounts it read-only). From your computer, in the folder with
`backup-public-key.asc`:

```bash
ssh you@unalgorithm.example.org "cd unalgorithm/apps/server && docker compose run --rm --no-deps -T --entrypoint sh keygen -c 'cat > /keys/backup-public-key.asc'" < backup-public-key.asc
```

Never run `keygen` here without `--entrypoint sh`: it would make a new key pair, and your old backups would still need
the old private key.

Then start the server as in section 5 (Start). Put the backup file back through the `backup` container, never with `cp`
or `scp` into `backups/` (root's folder). From your computer:

```bash
ssh you@unalgorithm.example.org "cd unalgorithm/apps/server && docker compose exec -T backup sh -c 'cat > /backups/<file>'" < ~/unalgorithm-backups/<file>
```

(With the stack down, use `docker compose run --rm --no-deps -T backup sh -c 'cat > /backups/<file>'` in that line
instead.)

Then restore, from your computer, with the private key on standard input. Check the backup, stop the server, replace
the database, start the server, and start a new sync epoch, so every browser syncs again from the restored copy and
sends its newer settings again:

```bash
ssh you@unalgorithm.example.org 'cd unalgorithm/apps/server && docker compose run --rm -T backup bash /scripts/restore.sh --check /backups/<file>' < backup-private-key.asc
ssh you@unalgorithm.example.org 'cd unalgorithm/apps/server && docker compose stop server'
ssh you@unalgorithm.example.org 'cd unalgorithm/apps/server && docker compose run --rm -T backup bash /scripts/restore.sh --yes /backups/<file>' < backup-private-key.asc
ssh you@unalgorithm.example.org 'cd unalgorithm/apps/server && docker compose start server'
ssh you@unalgorithm.example.org 'cd unalgorithm/apps/server && docker compose exec -T server node apps/server/src/cli/sync-new-epoch.ts'
```

`restore.sh --yes` refuses while the server is connected to the database, and logs a row count per table when done.

With Ollama, pull your model again, as in section 6 (models are not in the backup; the restored AI route has already
passed `route-eval`):

```bash
docker compose exec ollama ollama pull llama3.2:3b
```

Finish with a fresh backup, on the server, and check that the admin page shows an ok local backup:

```bash
docker compose exec backup bash /scripts/backup.sh --once
```

Restore into the same release or a newer one, never an older one.

## 12. Alerts and monitoring

The server checks itself and opens one of five alerts, each with its default (`.env` explains each setting):

- disk free under 5 GB (`ALERT_DISK_FREE_MIN_GB`);
- the database over 10 GB (`ALERT_DATABASE_MAX_GB`);
- 20 errors in 15 minutes in the server's log (`ALERT_ERRORS_PER_15M`);
- the daily AI spend limit reached (`DAILY_SPEND_LIMIT_USD`);
- a backup failed, or the last good one older than 26 hours (`ALERT_BACKUP_MAX_AGE_HOURS`).

The admins get an email when an alert opens, is still open a day later, and closes. To send it to other addresses, set
`ALERT_EMAIL` (comma-separated, or `none` for no email); to also post it to a chat webhook, set `ALERT_WEBHOOK_URL`. Test the delivery, and
see what each rule measures right now:

```bash
docker compose exec server node apps/server/src/cli/alerts.ts test
docker compose exec server node apps/server/src/cli/alerts.ts check
```

For a monitoring tool such as Prometheus, set `METRICS_TOKEN` (`openssl rand -hex 32`) and read `GET /metrics` with
the header `Authorization: Bearer` followed by that token.

A server that is down cannot send its own alert, so add one check from outside: any uptime service polling
`https://unalgorithm.example.org/health`.

## 13. Upgrade

Take a backup, then get the new release's files, on the server:

```bash
docker compose exec backup bash /scripts/backup.sh --once
git fetch --depth 1 origin tag server-v<version>
git checkout server-v<version>
```

The checkout brings the new `compose.yaml` and backup scripts. Set `UNALGORITHM_VERSION=<version>` in `.env`, then:

```bash
docker compose pull
docker compose up -d --wait
```

Read the release notes for extra steps, such as running `route-eval` again (section 6).

**Upgrading to the release with fact-check prompt version 2:** fact-check now researches with one search per claim plus
one (at most 5) at low effort, so its prompt version is 2. Fact-check and Other perspectives stay off until you run
`route-eval factcheck` again (section 6), about $3 with Anthropic.

## Using your own HTTPS proxy

If you already run an HTTPS proxy on this machine, leave `caddy` out of `COMPOSE_PROFILES`. Your proxy must:

- forward to `127.0.0.1:8787`, where the server listens (`BIND_ADDRESS` and `PORT` in `.env`);
- set `X-Forwarded-For` to the client's address, replacing what the client sent rather than appending to it, with
  `TRUST_PROXY=one-hop` in `.env`;
- stream request bodies instead of buffering them (in nginx, `proxy_request_buffering off`);
- keep no client addresses or query strings in its logs.

For nginx, follow its own [reverse proxy documentation](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/).

## Naming

Your server is named by `INSTANCE_NAME`: that is the name people see. "UnAlgorithm Cloud" is only HeitechSoft's own
service at cloud.unalgorithm.app, so don't call your server UnAlgorithm Cloud. You may run the unmodified server for
yourself or your organization; [TRADEMARKS.md](../TRADEMARKS.md) says what else you may and may not name after
UnAlgorithm.

## Privacy and your users

Your server keeps what sign-in, limits and usage need: each account's email address, its signed-in devices, daily usage
counts and, for people who turn sync on, their synced settings. It never stores the posts it classifies, and never anyone's
own API keys. [docs/privacy-model.md](privacy-model.md#what-a-server-stores) lists every table.

Backups hold every account as it was that night, including accounts deleted since, until the backup ages out of
`backups/` and out of every copy you keep elsewhere. As the operator, you answer to your users for their data.

## Troubleshooting

- **Something is wrong with the settings:** run `check-config` (section 3); it names each setting that is missing or
  wrong.
- **The server does not start or misbehaves:** read its log with `docker compose logs server`.
- **A port is already in use** (80 or 443 for Caddy, 8787 for the server): another web server or service holds it.
  `sudo ss -ltnp` shows which program listens on it; stop it, or use it as your own proxy (see above).
- **No certificate:** the domain does not point at this server yet. Check the DNS records (section 4), then read
  `docker compose logs caddy`.
- **`route-eval` does not pass:** try a larger model or lower `ROUTE_EVAL_MIN_AGREEMENT` (section 6). A provider error
  (a refused key, an unreachable endpoint) stores nothing: fix the setting and run it again.
- **The only admin lost access:** make a new admin with `setup-link.ts` and `--recover` (section 7).
