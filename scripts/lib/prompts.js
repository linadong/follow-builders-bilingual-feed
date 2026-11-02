// Prompt loader shared by both pipelines (upstream + local sources).
//
// Security: remote prompt fetching is permanently disabled in this install.
// Prompts are plain files on disk — never fetched from the network at runtime.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { USER_DIR } from './net.js';

export const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

/**
 * Load prompts with priority: user custom (~/.follow-builders/prompts) > skill default.
 * @param {string[]} errors mutation target — non-fatal problems get appended
 */
export async function loadPrompts(errors = [], skillPromptsDir) {
  const prompts = {};
  const localDir =
    skillPromptsDir || join(decodeURIComponent(new URL('../..', import.meta.url).pathname), 'prompts');
  const userDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userDir, filename);
    const localPath = join(localDir, filename);
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
    } else if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }
  return prompts;
}
