// X/Twitter readers for the local-source pipeline.
//
// X has no public unauthenticated timeline API, so this module supports three
// providers and degrades honestly:
//   api         — official X API v2, needs X_BEARER_TOKEN (paid tier)
//   syndication — cdn/embeds endpoint used by x.com embeds, no key, rate-limited
//   rss         — any RSS bridge you host yourself (RSSHub / Nitter), via template
//
// "auto" = api if a token exists, else syndication, else rss template if set.

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fetchText, fetchJSON, mapLimit, USER_DIR } from './net.js';
import { parseFeed } from './xml.js';

const UA_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Read KEY=VALUE lines from ~/.follow-builders/.env (never overwrite process env set elsewhere). */
export async function loadEnvFile() {
  const env = { ...process.env };
  const path = join(USER_DIR, '.env');
  if (!existsSync(path)) return env;
  try {
    const text = await readFile(path, 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (env[m[1]] === undefined) env[m[1]] = value;
    }
  } catch {
    /* unreadable .env is non-fatal */
  }
  return env;
}

function withinWindow(iso, windowHours) {
  if (!iso) return true; // no date -> keep, dedupe layer handles repeats
  return Date.now() - Date.parse(iso) <= windowHours * 3600 * 1000;
}

// -- provider: X API v2 ------------------------------------------------------

async function fetchViaApi(accounts, { windowHours, env }) {
  const token = env.X_BEARER_TOKEN || env.X_API_BEARER_TOKEN;
  if (!token) throw new Error('X_BEARER_TOKEN not set');
  const headers = { authorization: `Bearer ${token}` };
  const errors = [];

  const handles = accounts.map((a) => a.handle);
  const users = new Map();
  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100).join(',');
    const res = await fetchJSON(
      `https://api.x.com/2/users/by?usernames=${encodeURIComponent(batch)}&user.fields=description,name`,
      { headers, ttl: 3600 }
    ).catch((e) => {
      errors.push(`X API user lookup failed: ${e.message}`);
      return null;
    });
    for (const u of res?.data || []) users.set(u.username.toLowerCase(), u);
  }

  const results = await mapLimit(accounts, 4, async (account) => {
    const user = users.get(account.handle.toLowerCase());
    if (!user) return { ...account, bio: '', tweets: [] };
    const res = await fetchJSON(
      `https://api.x.com/2/users/${user.id}/tweets?max_results=10&tweet.fields=created_at,public_metrics&exclude=retweets,replies`,
      { headers, ttl: 600 }
    );
    const tweets = (res?.data || [])
      .filter((t) => withinWindow(t.created_at, windowHours))
      .map((t) => ({
        id: t.id,
        text: t.text,
        createdAt: t.created_at,
        url: `https://x.com/${account.handle}/status/${t.id}`,
        likes: t.public_metrics?.like_count ?? null,
        retweets: t.public_metrics?.retweet_count ?? null,
        replies: t.public_metrics?.reply_count ?? null
      }));
    return { ...account, bio: user.description || '', tweets };
  });

  return {
    accounts: results.map((r) => (r?.__error ? { ...r, tweets: [] } : r)),
    provider: 'api',
    errors: results.filter((r) => r?.__error).map((r) => `X API: ${r.__error}`).concat(errors)
  };
}

// -- provider: syndication (no key) -----------------------------------------

function collectTweets(node, out, depth = 0) {
  if (!node || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectTweets(child, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    if (typeof node.full_text === 'string' && (node.id_str || node.rest_id)) out.push(node);
    for (const key of Object.keys(node)) collectTweets(node[key], out, depth + 1);
  }
  return out;
}

function extractStatePayload(html) {
  const patterns = [
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* keep trying */
      }
    }
  }
  return null;
}

async function fetchViaSyndication(accounts, { windowHours }) {
  const results = await mapLimit(accounts, 3, async (account) => {
    const html = await fetchText(
      `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(account.handle)}`,
      { headers: { 'user-agent': UA_BROWSER, accept: 'text/html' }, ttl: 900, retries: 1 }
    );
    const payload = extractStatePayload(html);
    if (!payload) throw new Error('no timeline payload');
    const collected = collectTweets(payload, []);
    const tweets = collected
      .map((t) => ({
        id: t.id_str || t.rest_id,
        text: t.full_text,
        createdAt: t.created_at ? new Date(t.created_at).toISOString() : null,
        likes: t.favorite_count ?? null,
        retweets: t.retweet_count ?? null,
        replies: t.reply_count ?? null
      }))
      .filter((t) => t.id && t.text)
      .filter((t) => withinWindow(t.createdAt, windowHours))
      .map((t) => ({ ...t, url: `https://x.com/${account.handle}/status/${t.id}` }));

    const bio =
      payload?.profileUser?.description ||
      payload?.user?.description ||
      collected[0]?.user?.description ||
      '';

    // dedupe by id, newest first
    const seen = new Set();
    return {
      ...account,
      bio,
      tweets: tweets
        .filter((t) => !seen.has(t.id) && seen.add(t.id))
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
        .slice(0, 10)
    };
  });

  const failures = results.filter((r) => r?.__error);
  if (failures.length === accounts.length) {
    throw new Error(`syndication failed for all accounts (${failures[0].__error})`);
  }
  return {
    accounts: results.map((r) => (r?.__error ? { ...r, bio: '', tweets: [] } : r)),
    provider: 'syndication',
    errors: failures.map((r) => `X syndication: ${r.__error} (${r.handle || 'unknown'})`)
  };
}

// -- provider: generic RSS bridge -------------------------------------------

async function fetchViaRss(accounts, { windowHours, rssTemplate }) {
  if (!rssTemplate) throw new Error('no rssTemplate configured');
  const results = await mapLimit(accounts, 4, async (account) => {
    const url = rssTemplate.replace(/\{handle\}/g, account.handle).replace(/\{username\}/g, account.handle);
    const xml = await fetchText(url, { ttl: 900, retries: 1 });
    const { items } = parseFeed(xml, { limit: 15, contentLimit: 2000 });
    const tweets = items
      .filter((it) => withinWindow(it.date, windowHours))
      .map((it, i) => ({
        id: it.guid || it.link || String(i),
        text: it.content || it.title,
        createdAt: it.date,
        url: it.link,
        likes: null,
        retweets: null,
        replies: null
      }));
    return { ...account, bio: '', tweets };
  });
  const failures = results.filter((r) => r?.__error);
  if (failures.length === accounts.length) throw new Error(`rss bridge failed (${failures[0].__error})`);
  return {
    accounts: results.map((r) => (r?.__error ? { ...r, bio: '', tweets: [] } : r)),
    provider: 'rss',
    errors: failures.map((r) => `X rss: ${r.__error}`)
  };
}

/**
 * Entry point.
 * @returns {Promise<{accounts:Array, provider:string, errors:string[]}>}
 */
export async function fetchX(accounts, { provider = 'auto', rssTemplate = '', windowHours = 36 } = {}) {
  const env = await loadEnvFile();
  const hasToken = Boolean(env.X_BEARER_TOKEN || env.X_API_BEARER_TOKEN);
  const order =
    provider === 'auto'
      ? [hasToken ? 'api' : null, 'syndication', rssTemplate ? 'rss' : null].filter(Boolean)
      : [provider];

  const errors = [];
  for (const candidate of order) {
    try {
      if (candidate === 'api') return await fetchViaApi(accounts, { windowHours, env });
      if (candidate === 'syndication') return await fetchViaSyndication(accounts, { windowHours });
      if (candidate === 'rss') return await fetchViaRss(accounts, { windowHours, rssTemplate });
    } catch (err) {
      errors.push(`X provider "${candidate}" unavailable: ${err.message}`);
    }
  }
  return { accounts: [], provider: 'none', errors };
}
