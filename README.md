# allianz-index-data

Daily closing values for the indexes displayed at [becoach.ai/abc](https://becoach.ai/abc).

The app reads `daily-values.json` directly from `raw.githubusercontent.com`, so every push to `main` updates the site with no rebuild.

## How the daily update works

A [launchd job](#runtime) on the M4 Mac Mini fires `fetch-all.mjs` at **21:07 ET on weekdays**, which:

1. `git pull` the repo
2. Run the fetcher (parallel, no deps)
3. Append a line to `runs.log`
4. Commit and push

After the job runs, a commit titled `Daily run YYYY-MM-DD-HHMM [CHANGED|NO_CHANGE]` appears here. That commit list is the health dashboard.

## Index coverage

| Index | Ticker | Source | Daily? |
|---|---|---|---|
| PIMCO Tactical Balanced ER | DBTBIER | pimcoindex.com JSON | ✅ |
| S&P 500 | SPX | FRED CSV | ✅ |
| Nasdaq-100 | NDX | FRED CSV | ✅ |
| Russell 2000 | RUT | Yahoo `^RUT` | ✅ |
| S&P 500 Futures RC5% ER | SPXT5UE | Yahoo `^SPXT5UE` | ✅ |
| Morgan Stanley ST10 ER | MSST10ER | morganstanley.com TXT | ✅ |
| Bloomberg US Dynamic Balance II | BXIIUDB2 | Bloomberg WP JSON | ❌ PerimeterX |
| Bloomberg US Dynamic Balance II ER | BTSIDB2E | Bloomberg WP JSON | ❌ PerimeterX |
| Bloomberg US Dynamic Balance III ER | BTSIUDB3 | Bloomberg WP JSON | ❌ PerimeterX |
| Bloomberg US Small Cap ER | BTSIUSCF | Bloomberg WP JSON | ❌ PerimeterX |
| S&P 500 Futures ER | SPXFP | (none found) | 🟡 manual monthly |
| BlackRock iBLD Claria ER | IBLDCLER | (JS-loaded, Akamai-blocked) | 🟡 manual monthly |

**6 of 12 indexes are fully automated.** The 4 Bloomberg ones 403 from every IP we've tested (dev laptop, Anthropic cloud, M4). The 2 manual ones have no free daily source. See [history](#why-not-bloomberg) for details.

## Files

- `fetch-all.mjs` — the fetcher. Node, zero deps. Run modes:
  - `node fetch-all.mjs` — latest close only
  - `node fetch-all.mjs --backfill` — last ~30 days
  - `node fetch-all.mjs --dry-run` — fetch without writing
- `daily-values.json` — `{ indexId: { "YYYY-MM-DD": value } }`. The app reads this.
- `all-indexes.json` — index metadata and product rates for the tracker page.
- `runs.log` — one line per scheduled run (timestamp | status | per-source outcome).

## Runtime

Everything lives on the **M4 Mac Mini** (`tony@100.95.2.66`):

```
~/allianz-fetcher/
  allianz-index-data/        # clone of this repo
  run-daily.sh               # launchd wrapper
  run.log                    # local run log (verbose)
  launchd.out.log            # launchd stdout
  launchd.err.log            # launchd stderr

~/Library/LaunchAgents/com.daocoding.allianz-index-fetcher.plist
```

Authentication: `gh auth login --with-token` on M4 under the `daocoding` account, using a fine-grained PAT scoped to **this repo only** with `contents: write`.

## Operations

### Is it working?
Look at the [commits page](../../commits/main). There should be a `Daily run …` commit every weekday after 9:07pm ET.

### Run it manually on M4
```bash
ssh tony@100.95.2.66
launchctl kickstart -p gui/$(id -u)/com.daocoding.allianz-index-fetcher
tail -30 ~/allianz-fetcher/run.log
```

### Backfill missing days
```bash
ssh tony@100.95.2.66
cd ~/allianz-fetcher/allianz-index-data
git pull
node fetch-all.mjs --backfill
git add daily-values.json && git commit -m "Backfill $(date -u +%F)" && git push
```

### Rotate the PAT
1. Revoke old at https://github.com/settings/personal-access-tokens
2. Create new fine-grained PAT: `daocoding/allianz-index-data` only, `contents: write`
3. On M4: `echo "<new-pat>" | gh auth login --with-token`

### Disable the schedule
```bash
launchctl unload ~/Library/LaunchAgents/com.daocoding.allianz-index-fetcher.plist
```
Re-enable with `launchctl load -w ...`.

## Why not Bloomberg

The Bloomberg WP JSON endpoint returns all 4 tracked Bloomberg indexes in one call. It worked briefly during initial development. It then started returning HTTP 403 with PerimeterX challenges from our dev IP, M4 IP, and Anthropic cloud IP alike. We've left the fetcher code in place as soft-fail; if Bloomberg unblocks, the 4 indexes resume automatically.

Meanwhile, a local polling monitor on M1Max (`bbg-update-monitor.sh`) captures values periodically via a different path. Bringing those into this flow is a future task.

## Why not Anthropic Routines / GitHub Actions

- **Anthropic Routines (scheduled remote triggers):** tested 2026-04-15. Every financial data source (Bloomberg, PIMCO, FRED, MS, Yahoo) 403'd from Anthropic's egress IPs — shared datacenter IPs flagged by CDNs. Disabled trigger `trig_01GCDeqd7uW7Bfrq5VCWEGo2` kept as future path if Anthropic whitelists or we add a proxy.
- **GitHub Actions:** untested. Azure IPs likely face the same datacenter-block problem. Revisit if M4 proves unreliable after a month.

## History

- 2026-03-29 — Initial scripts and product page built.
- 2026-03-30 — Data migrated to this repo; site wired to read from raw.githubusercontent.com.
- 2026-04-15 — Consolidated 6 sources into one script; set up launchd on M4; backfilled 3-week gap.
