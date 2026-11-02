#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

// LOCAL PATCH: Node's global fetch ignores HTTP_PROXY/HTTPS_PROXY by default.
// In environments that route egress through a proxy, fetches hang until the
// socket times out. Enabling the env-proxy agent makes it honour *_PROXY vars.
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1';

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { loadPrompts } from './lib/prompts.js';
import { fetchText as netFetchText } from './lib/net.js';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';

// SECURITY (local hardening): upstream fetched prompt .md files from GitHub at
// runtime and had the agent execute them as instructions — a remote prompt
// injection vector. This install pins prompts to disk. Remote fetch is disabled.
const USE_REMOTE_PROMPTS = false;

// -- Fetch helpers -----------------------------------------------------------

// LOCAL PATCH: hard timeout so a bad network never hangs the digest run.
const FETCH_TIMEOUT_MS = 30000;

// Transport goes through lib/net.js: curl first, undici fallback. Plain fetch
// stalls on some hosts in this environment (see net.js for the reason).
async function fetchJSON(url) {
  try {
    return JSON.parse(await netFetchText(url, { ttl: 1800, retries: 1 }));
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    return await netFetchText(url, { ttl: 1800, retries: 1 });
  } catch {
    return null;
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Local source mode (see prepare-local.js) — bypasses the upstream feed.
  //    Checked BEFORE any network call so a flaky upstream can't break a local run.
  const mode = process.env.FB_SOURCES_MODE || config.sources?.mode || 'upstream';
  if (mode !== 'upstream') {
    const { buildLocalDigest } = await import('./prepare-local.js');
    const local = await buildLocalDigest(config, { mode });
    console.log(JSON.stringify(local, null, 2));
    return;
  }

  // 2b. Fetch all three feeds (curl transport — see lib/net.js)
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL)
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');
  if (feedX?.errors?.length) {
    errors.push(
      ...feedX.errors.map((error) => `Tweet feed problem: ${error}`)
    );
  }
  if (feedPodcasts?.errors?.length) {
    errors.push(
      ...feedPodcasts.errors.map((error) => `Podcast feed problem: ${error}`)
    );
  }
  if (feedBlogs?.errors?.length) {
    errors.push(
      ...feedBlogs.errors.map((error) => `Blog feed problem: ${error}`)
    );
  }

  // 3. Load prompts with priority: user custom > local default
  //
  // If the user has a custom prompt at ~/.follow-builders/prompts/<file>,
  // use that (they personalized it).
  // Otherwise use the local copy shipped with the skill.
  //
  // NOTE: remote (GitHub) prompt fetching is intentionally disabled in this
  // install — see USE_REMOTE_PROMPTS above.
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const prompts = await loadPrompts(errors, join(scriptDir, '..', 'prompts'));

  // 4. Build the output — everything the LLM needs in one blob
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],
    blogs: feedBlogs?.blogs || [],

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Non-fatal errors
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
