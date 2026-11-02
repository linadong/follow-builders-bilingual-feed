// Network helpers shared by the local-source pipeline.
//
// Node's global fetch ignores HTTP_PROXY/HTTPS_PROXY unless the env-proxy agent
// is enabled; without this, every egress hangs until the socket times out.
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1';

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

export const USER_DIR = join(homedir(), '.follow-builders');
const CACHE_DIR = join(USER_DIR, 'cache');

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const FETCH_TIMEOUT_MS = Number(process.env.FB_FETCH_TIMEOUT_MS || 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheFile(url) {
  return join(CACHE_DIR, createHash('sha1').update(url).digest('hex') + '.json');
}

/**
 * Fetch a URL as text.
 * @param {string} url
 * @param {{ttl?:number, timeout?:number, retries?:number, headers?:object}} opts
 *   ttl > 0 enables the on-disk cache (seconds). 0 disables it.
 */

/**
 * Transport 1: curl.
 * Node's fetch/undici fails with UND_ERR_CONNECT_TIMEOUT on some hosts in this
 * environment (proxy + dual-stack DNS quirks) while curl negotiates the same
 * URLs fine, so curl is the primary transport and fetch is the fallback.
 */
function viaCurl(url, timeoutSec, headers = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--compressed', '--max-time', String(timeoutSec), '-A', UA];
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'user-agent') continue;
      args.push('-H', `${k}: ${v}`);
    }
    args.push(url);
    execFile(
      'curl',
      args,
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        if (!stdout) return reject(new Error('empty response'));
        resolve(stdout);
      }
    );
  });
}

async function viaFetch(url, timeoutMs, headers = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': UA, accept: '*/*', ...headers }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function fetchText(url, opts = {}) {
  const { ttl = 0, timeout = FETCH_TIMEOUT_MS, retries = 1, headers = {} } = opts;

  if (ttl > 0) {
    await mkdir(CACHE_DIR, { recursive: true });
    const file = cacheFile(url);
    if (existsSync(file)) {
      try {
        const { ts, body } = JSON.parse(await readFile(file, 'utf-8'));
        if (Date.now() - ts < ttl * 1000) return body;
      } catch {
        // corrupt cache entry — fall through and refetch
      }
    }
  }

  const timeoutSec = Math.ceil(timeout / 1000);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let body;
      try {
        body = await viaCurl(url, timeoutSec, headers);
      } catch (curlErr) {
        // curl missing or refused — fall back to undici
        body = await viaFetch(url, timeout, headers);
      }
      if (ttl > 0) {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cacheFile(url), JSON.stringify({ ts: Date.now(), body })).catch(() => {});
      }
      return body;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function fetchJSON(url, opts = {}) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}

/** Fetch many URLs with bounded concurrency. Never rejects. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { __error: err.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
