#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest from LOCAL sources
// ============================================================================
// Same output contract as prepare-digest.js, but the source list lives on this
// machine (~/.follow-builders/sources.json) instead of the upstream repo feed.
// Edit that file to add/remove builders, podcasts and blogs — changes take
// effect on the next run and survive upstream skill updates.
//
// Modes:
//   local   — only local sources (X needs a working provider, else it's empty)
//   hybrid  — local podcasts + blogs; X falls back to the upstream feed
//             when no local X provider works
//
// Usage: node prepare-local.js [--mode=local|hybrid] [--window=N] [--no-seen]
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

import { fetchText, fetchJSON, mapLimit, USER_DIR } from './lib/net.js';
import { parseFeed, htmlToArticle, extractLinks } from './lib/xml.js';
import { fetchX } from './lib/x.js';
import { loadPrompts } from './lib/prompts.js';

const SKILL_DIR = join(decodeURIComponent(new URL('..', import.meta.url).pathname));
const SKILL_SOURCES = join(SKILL_DIR, 'config', 'default-sources.json');
const USER_SOURCES = join(USER_DIR, 'sources.json');
const SEEN_PATH = join(USER_DIR, 'seen.json');
const UPSTREAM_X = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const UPSTREAM_PODCASTS =
  'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';

const SEEN_MAX_AGE_DAYS = 60;
const SEEN_MAX_ENTRIES = 4000;

// -- sources file ------------------------------------------------------------

function migrateV1(v1) {
  return {
    version: 2,
    windowHours: 48,
    podcasts: (v1.podcasts || []).map((p) => ({ name: p.name, rssUrl: p.rssUrl, url: p.url })),
    blogs: (v1.blogs || []).map((b) => ({
      name: b.name,
      type: b.type === 'scrape' ? 'scrape' : 'rss',
      rssUrl: b.rssUrl || null,
      indexUrl: b.indexUrl || null,
      articleBaseUrl: b.articleBaseUrl || null,
      url: b.url || b.indexUrl || b.rssUrl
    })),
    x: {
      provider: 'auto',
      rssTemplate: '',
      accounts: (v1.x_accounts || []).map((a) => ({ name: a.name, handle: a.handle }))
    }
  };
}

export async function loadSources(explicitPath) {
  const path = explicitPath || USER_SOURCES;
  if (existsSync(path)) {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    if (raw.version === 2) return { path, sources: raw, migrated: false };
    return { path, sources: migrateV1(raw), migrated: true };
  }
  if (existsSync(SKILL_SOURCES)) {
    const v1 = JSON.parse(await readFile(SKILL_SOURCES, 'utf-8'));
    const sources = migrateV1(v1);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(sources, null, 2));
    return { path, sources, migrated: true };
  }
  throw new Error(`No sources file at ${path} and no default at ${SKILL_SOURCES}`);
}

// -- dedupe store ------------------------------------------------------------

async function loadSeen() {
  if (process.env.FB_SEEN === '0') return null;
  if (!existsSync(SEEN_PATH)) return {};
  try {
    return JSON.parse(await readFile(SEEN_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveSeen(seen) {
  if (process.env.FB_SEEN === '0' || !seen) return;
  const cutoff = Date.now() - SEEN_MAX_AGE_DAYS * 86400_000;
  const entries = Object.entries(seen).filter(([, ts]) => Date.parse(ts) > cutoff);
  entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  const trimmed = Object.fromEntries(entries.slice(0, SEEN_MAX_ENTRIES));
  await mkdir(dirname(SEEN_PATH), { recursive: true });
  await writeFile(SEEN_PATH, JSON.stringify(trimmed, null, 2));
}

// -- fetchers ----------------------------------------------------------------

// VTT/SRT timing noise removal (only used if a feed publishes transcripts)
function cleanTranscript(raw) {
  if (!raw) return null;
  return raw
    .replace(/\r/g, '')
    .replace(/^\s*\d+\s*$/gm, '')
    .replace(/^\s*WEBVTT.*$/gm, '')
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchTranscript(url) {
  if (!url) return null;
  try {
    const raw = await fetchText(url, { ttl: 86400, retries: 1, timeout: 45000 });
    if (raw.trim().startsWith('{')) {
      // some providers return {segments:[{text}]}
      const parsed = JSON.parse(raw);
      const text =
        parsed.text ||
        (Array.isArray(parsed.segments) ? parsed.segments.map((s) => s.text).join(' ') : '');
      return text ? text.trim() : null;
    }
    return cleanTranscript(raw) || null;
  } catch {
    return null;
  }
}

async function collectPodcasts(sources, windowHours, seen, errors) {
  const out = [];
  const results = await mapLimit(sources, 3, async (src) => {
    try {
      const xml = await fetchText(src.rssUrl, { ttl: 1800, retries: 1, timeout: 45000 });
      const { items } = parseFeed(xml, { limit: 12, contentLimit: 4000 });
      return { src, items };
    } catch (err) {
      return { src, __error: err.message };
    }
  });

  for (const res of results) {
    if (!res || res.__error || !res.src) {
      errors.push(`Podcast feed failed [${res?.src?.name || '?'}]: ${res?.__error || 'unknown'}`);
      continue;
    }
    for (const item of res.items) {
      if (!item.link && !item.title) continue;
      if (item.date && Date.now() - Date.parse(item.date) > windowHours * 3600_000) continue;
      const url = res.src.url || res.src.rssUrl;
      if (seen && seen[item.link]) continue;
      const transcript = await fetchTranscript(item.transcriptUrl);
      out.push({
        source: 'podcast',
        name: res.src.name,
        title: item.title,
        guid: item.guid || item.link,
        url: item.link || url,
        channelUrl: url,
        publishedAt: item.date,
        // RSS gives show notes, not transcripts. Never fabricate a transcript.
        notes: item.content,
        transcript,
        hasTranscript: Boolean(transcript)
      });
      if (seen) seen[item.link] = new Date().toISOString();
    }
  }
  return out;
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * hybrid only: the upstream podcast feed carries full transcripts, which local
 * RSS never has. Keep upstream entries (deduped by title) and append local
 * episodes the upstream list doesn't cover — i.e. shows the user added.
 */
async function mergeUpstreamPodcasts(local, seen, errors) {
  const upstream = await fetchJSON(UPSTREAM_PODCASTS, { ttl: 1800 }).catch(() => null);
  if (!upstream?.podcasts?.length) return local;

  // Upstream already curates "recent" episodes (and backfills transcripts), so
  // its entries are NOT re-filtered by our window — only deduped. Local RSS
  // feeds hold years of archives, so those stay window-filtered.
  const fresh = upstream.podcasts.slice(0, 3);
  const upstreamTitles = new Set(fresh.map((p) => norm(p.title)));
  const merged = [];

  for (const ep of fresh) {
    const seenKey = `podcast:${norm(ep.title)}`;
    if (seen && seen[seenKey]) continue;
    merged.push({ ...ep, hasTranscript: Boolean(ep.transcript) });
    if (seen) seen[seenKey] = new Date().toISOString();
  }
  for (const ep of local) {
    if (upstreamTitles.has(norm(ep.title))) continue; // upstream version has the transcript
    merged.push(ep);
  }
  if (!fresh.length) errors.push('Upstream podcast feed returned no recent episodes');
  return merged;
}

async function collectBlogs(sources, windowHours, seen, errors) {
  const out = [];
  const results = await mapLimit(sources, 3, async (src) => {
   try {
    if (src.type === 'scrape') {
      const html = await fetchText(src.indexUrl, { ttl: 3600, retries: 1 });
      const links = extractLinks(html, src.articleBaseUrl || src.indexUrl, src.maxArticles || 8);
      const articles = await mapLimit(links.slice(0, 4), 3, async (link) => {
        if (seen && seen[link]) return null;
        const page = await fetchText(link, { ttl: 86400, retries: 1 });
        const { title, content } = htmlToArticle(page, 6000);
        return { title, content, url: link, publishedAt: null };
      });
      return { src, items: articles.filter(Boolean) };
    }
    const xml = await fetchText(src.rssUrl, { ttl: 1800, retries: 1, timeout: 45000 });
    const { items } = parseFeed(xml, { limit: 10, contentLimit: 6000 });
    return {
      src,
      items: items.map((it) => ({
        title: it.title,
        content: it.content,
        url: it.link,
        publishedAt: it.date
      }))
    };
   } catch (err) {
     return { src, __error: err.message };
   }
  });

  for (const res of results) {
    if (!res || res.__error || !res.src) {
      errors.push(`Blog source failed [${res?.src?.name || '?'}]: ${res?.__error || 'unknown'}`);
      continue;
    }
    for (const item of res.items) {
      if (!item.url || !item.title) continue;
      if (item.publishedAt && Date.now() - Date.parse(item.publishedAt) > windowHours * 3600_000) continue;
      if (seen && seen[item.url]) continue;
      out.push({
        source: 'blog',
        name: res.src.name,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        content: item.content
      });
      if (seen) seen[item.url] = new Date().toISOString();
    }
  }
  return out;
}

async function collectX(sources, windowHours, mode, errors) {
  const { accounts, provider, rssTemplate } = sources.x || {};
  if (!accounts?.length) return { list: [], provider: 'none' };

  const local = await fetchX(accounts, {
    provider: provider || 'auto',
    rssTemplate,
    windowHours
  });
  errors.push(...(local.errors || []));

  const hasContent = local.accounts.some((a) => (a.tweets || []).length > 0);
  if (hasContent || mode === 'local') {
    return {
      list: local.accounts
        .filter((a) => (a.tweets || []).length > 0)
        .map((a) => ({
          source: 'x',
          name: a.name,
          handle: a.handle,
          bio: a.bio || '',
          tweets: a.tweets
        })),
      provider: local.provider
    };
  }

  // hybrid fallback: no local X provider worked — use the upstream feed
  const upstream = await fetchJSON(UPSTREAM_X, { ttl: 1800 }).catch(() => null);
  if (upstream?.x?.length) {
    errors.push('X: no local provider available this run — fell back to the upstream feed');
    return { list: upstream.x, provider: 'upstream-fallback' };
  }
  return { list: [], provider: local.provider };
}

// -- main --------------------------------------------------------------------

export async function buildLocalDigest(userConfig, opts = {}) {
  const errors = [];
  const mode = opts.mode || 'hybrid';
  const { path: sourcesPath, sources } = await loadSources(opts.sourcesFile || userConfig.sources?.file);
  const windowHours = Number(opts.windowHours || sources.windowHours || 48);
  const seen = await loadSeen();

  // Podcasts publish weekly-ish, so they get a wider window than posts/blogs.
  const podcastWindowHours = Number(sources.podcastWindowHours || windowHours * 2.5);

  const [localPodcasts, blogs, x] = await Promise.all([
    collectPodcasts(sources.podcasts || [], podcastWindowHours, seen, errors),
    collectBlogs(sources.blogs || [], windowHours, seen, errors),
    collectX(sources, windowHours, mode, errors)
  ]);
  const podcasts =
    mode === 'hybrid'
      ? await mergeUpstreamPodcasts(localPodcasts, seen, errors)
      : localPodcasts;

  await saveSeen(seen);

  const prompts = await loadPrompts(errors, join(SKILL_DIR, 'prompts'));

  return {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config: {
      language: userConfig.language || 'en',
      frequency: userConfig.frequency || 'daily',
      delivery: userConfig.delivery || { method: 'stdout' }
    },
    sources: {
      mode,
      file: sourcesPath,
      windowHours,
      xProvider: x.provider,
      podcastWindowHours,
      podcastCount: (sources.podcasts || []).length,
      blogCount: (sources.blogs || []).length,
      xAccountCount: (sources.x?.accounts || []).length
    },
    podcasts,
    x: x.list,
    blogs,
    stats: {
      podcastEpisodes: podcasts.length,
      xBuilders: x.list.length,
      totalTweets: x.list.reduce((sum, a) => sum + (a.tweets?.length || 0), 0),
      blogPosts: blogs.length,
      feedGeneratedAt: null
    },
    prompts,
    errors: errors.length ? errors : undefined
  };
}

// -- CLI ---------------------------------------------------------------------

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCli) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : fallback;
  };
  if (args.includes('--no-seen')) process.env.FB_SEEN = '0';

  let userConfig = { language: 'en', frequency: 'daily', delivery: { method: 'stdout' } };
  const cfgPath = join(USER_DIR, 'config.json');
  if (existsSync(cfgPath)) userConfig = JSON.parse(await readFile(cfgPath, 'utf-8'));

  try {
    const out = await buildLocalDigest(userConfig, {
      mode: flag('mode', 'hybrid'),
      windowHours: Number(flag('window', 0)) || undefined
    });
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ status: 'error', message: err.message }));
    process.exit(1);
  }
}
