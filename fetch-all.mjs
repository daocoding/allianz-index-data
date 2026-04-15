#!/usr/bin/env node
// fetch-all.mjs — Daily index value collector for Allianz FIA index tracker.
//
// Usage:
//   node fetch-all.mjs            # fetch latest close for all automated indexes
//   node fetch-all.mjs --backfill # pull historical series (last ~30 days)
//   node fetch-all.mjs --dry-run  # fetch and print but don't write file
//
// Reads/writes: ./daily-values.json
// Exits non-zero on fatal error. Per-index failures are logged but non-fatal.

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    backfill: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const today = new Date().toISOString().slice(0, 10);
const DATA_FILE = new URL('./daily-values.json', import.meta.url);

// ──────────────────────────────────────────────────────────
// Fetchers. Each returns { [indexId]: { [YYYY-MM-DD]: number } }
// ──────────────────────────────────────────────────────────

async function fetchBloomberg() {
  // One call returns all 4 Bloomberg indexes. No date field — assume latest close.
  // Bloomberg uses PerimeterX; sometimes blocks non-browser clients. Retry once.
  let r, lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      r = await fetch(
        'https://www.bloomberg.com/professional/wp-json/ticker-table/v1/feed?type=strategies',
        {
          headers: {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.bloomberg.com/professional/',
          },
        }
      );
      if (r.ok) break;
      lastErr = new Error(`Bloomberg HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }
  if (!r || !r.ok) throw lastErr || new Error('Bloomberg unreachable');
  const d = await r.json();
  const map = {
    BTSIDB2E: 'bloomberg-dynbal2-er',
    BTSIUDB3: 'bloomberg-dynbal3-er',
    BXIIUDB2: 'bloomberg-dynbal2',
    BTSIUSCF: 'bbg-smallcap-er',
  };
  const out = {};
  // Response shape: { strategies: [ { ticker, value, ... }, ... ] } or nested.
  const stack = [d];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    if (cur && typeof cur === 'object') {
      if (cur.ticker && map[cur.ticker] && cur.value != null) {
        const id = map[cur.ticker];
        out[id] = { [today]: Number(parseFloat(cur.value).toFixed(4)) };
      }
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return out;
}

async function fetchPimco(backfill) {
  const start = backfill ? '2026-03-20' : offsetDate(-7);
  const r = await fetch(
    `https://www.pimcoindex.com/pimind-api/api/historical/EOD/TBIR?startDate=${start}&endDate=${today}&isCustom=false`,
    { headers: { 'User-Agent': UA } }
  );
  if (!r.ok) throw new Error(`PIMCO ${r.status}`);
  const d = await r.json();
  const series = {};
  for (let i = 0; i < d.historicalDates.length; i++) {
    const date = d.historicalDates[i].slice(0, 10);
    series[date] = Number(parseFloat(d.historicalData[i]).toFixed(4));
  }
  return { 'pimco-tbier': backfill ? series : lastEntry(series) };
}

async function fetchFred(fredId, indexId, backfill) {
  const start = backfill ? '2026-03-20' : offsetDate(-7);
  const r = await fetch(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${fredId}&cosd=${start}&coed=${today}`,
    { redirect: 'follow' }
  );
  if (!r.ok) throw new Error(`FRED ${fredId} ${r.status}`);
  const text = await r.text();
  const series = {};
  for (const line of text.trim().split('\n').slice(1)) {
    const [date, val] = line.split(',');
    if (val && val !== '.') series[date] = Number(parseFloat(val).toFixed(4));
  }
  return { [indexId]: backfill ? series : lastEntry(series) };
}

async function fetchMorganStanley() {
  // Morgan Stanley returns only the latest value — no historical range.
  const r = await fetch(
    'https://www.morganstanley.com/qispubindices/st10/ReturnData.txt',
    { headers: { 'User-Agent': UA } }
  );
  if (!r.ok) throw new Error(`MS ST10 ${r.status}`);
  const d = await r.json();
  // date format: "10-Apr-2026"
  const date = parseDDMonYYYY(d.date);
  return { 'ms-st10-er': { [date]: Number(parseFloat(d.index).toFixed(4)) } };
}

async function fetchYahoo(symbol, indexId, backfill) {
  const range = backfill ? '1mo' : '5d';
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
    { headers: { 'User-Agent': UA } }
  );
  if (!r.ok) throw new Error(`Yahoo ${symbol} ${r.status}`);
  const d = await r.json();
  if (d.chart.error) throw new Error(`Yahoo ${symbol} err: ${JSON.stringify(d.chart.error)}`);
  const res = d.chart.result[0];
  const series = {};
  const ts = res.timestamp ?? [];
  const close = res.indicators.quote[0].close ?? [];
  for (let i = 0; i < ts.length; i++) {
    if (close[i] == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    series[date] = Number(parseFloat(close[i]).toFixed(4));
  }
  return { [indexId]: backfill ? series : lastEntry(series) };
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function offsetDate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function lastEntry(series) {
  const dates = Object.keys(series).sort();
  if (!dates.length) return {};
  const last = dates[dates.length - 1];
  return { [last]: series[last] };
}

function parseDDMonYYYY(s) {
  // "10-Apr-2026" → "2026-04-10"
  const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const [d, m, y] = s.split('-');
  return `${y}-${months[m]}-${d.padStart(2,'0')}`;
}

// ──────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────

const backfill = args.backfill;
const fetchers = [
  ['Bloomberg',       () => fetchBloomberg()],
  ['PIMCO',           () => fetchPimco(backfill)],
  ['S&P 500 (FRED)',  () => fetchFred('SP500',     'sp500',            backfill)],
  ['Nasdaq-100',      () => fetchFred('NASDAQ100', 'nasdaq100',        backfill)],
  ['MS ST10 ER',      () => fetchMorganStanley()],
  ['Russell 2000',    () => fetchYahoo('^RUT',      'russell-2000',    backfill)],
  ['SPX Futures RC5', () => fetchYahoo('^SPXT5UE',  'sp500-futures-rc5', backfill)],
];

console.log(`[fetch-all] ${backfill ? 'BACKFILL' : 'daily'} run @ ${new Date().toISOString()}`);

const results = await Promise.allSettled(fetchers.map(([_, fn]) => fn()));

const merged = {};
const summary = [];
for (let i = 0; i < fetchers.length; i++) {
  const [name] = fetchers[i];
  const r = results[i];
  if (r.status === 'fulfilled') {
    Object.assign(merged, r.value);
    const ids = Object.keys(r.value);
    const pts = ids.reduce((n, id) => n + Object.keys(r.value[id]).length, 0);
    summary.push(`  ✅ ${name}: ${ids.length} index(es), ${pts} point(s)`);
  } else {
    summary.push(`  ❌ ${name}: ${r.reason.message}`);
  }
}
console.log(summary.join('\n'));

// Load existing file, merge (keep existing dates, new values win on conflict)
const existing = JSON.parse(await readFile(DATA_FILE, 'utf8'));
let added = 0, updated = 0;
for (const [idxId, series] of Object.entries(merged)) {
  if (!existing[idxId]) existing[idxId] = {};
  for (const [date, val] of Object.entries(series)) {
    if (existing[idxId][date] == null) added++;
    else if (existing[idxId][date] !== val) updated++;
    existing[idxId][date] = val;
  }
}

console.log(`[fetch-all] ${added} new, ${updated} updated, ${Object.keys(merged).length} indexes touched`);

if (args['dry-run']) {
  console.log('[fetch-all] dry-run, not writing');
} else if (added === 0 && updated === 0) {
  console.log('[fetch-all] no changes, not writing');
} else {
  await writeFile(DATA_FILE, JSON.stringify(existing, null, 0));
  console.log(`[fetch-all] wrote ${DATA_FILE.pathname}`);
}
