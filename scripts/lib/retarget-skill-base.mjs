import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every cove-* skill tells the agent which URL to curl, and the repository copy
// names the default port because that is what an ordinary install serves. The
// installer already resolved the port this install actually runs on, so the
// copies it lays down are retargeted to it. A skill left pointing at 3200 on an
// install that took another port fails at the curl, which the agent reads as
// Cove being down rather than as an instruction that is out of date.
export const SKILL_DEFAULT_BASE = 'http://localhost:3200';

function loopbackOrigin(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Skill base URL must be an HTTP loopback origin without a path, credentials, query or fragment.');
  }
  return url.origin;
}

function markdownFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full));
    else if (entry.toLowerCase().endsWith('.md')) found.push(full);
  }
  return found;
}

/** Point the installed cove-* skills at this install's web address. */
export function retargetSkillBaseUrl(skillsDir, baseUrl) {
  const origin = loopbackOrigin(baseUrl);
  let files = 0;
  let replacements = 0;
  for (const entry of readdirSync(skillsDir)) {
    if (!entry.startsWith('cove-')) continue;
    const skillDir = path.join(skillsDir, entry);
    if (!statSync(skillDir).isDirectory()) continue;
    for (const file of markdownFiles(skillDir)) {
      const original = readFileSync(file, 'utf8');
      const occurrences = original.split(SKILL_DEFAULT_BASE).length - 1;
      if (occurrences === 0) continue;
      if (origin === SKILL_DEFAULT_BASE) { replacements += occurrences; files += 1; continue; }
      writeFileSync(file, original.replaceAll(SKILL_DEFAULT_BASE, origin), { encoding: 'utf8' });
      files += 1;
      replacements += occurrences;
    }
  }
  return { files, replacements };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [skillsDir, baseUrl] = process.argv.slice(2);
  if (!skillsDir || !baseUrl) throw new Error('Usage: retarget-skill-base.mjs <skills dir> <base url>');
  retargetSkillBaseUrl(skillsDir, baseUrl);
}
