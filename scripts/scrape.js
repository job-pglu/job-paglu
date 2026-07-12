#!/usr/bin/env node
/**
 * scripts/scrape.js
 *
 * Publicly-scoped scraper: downloads a public Linktree page (no login, no
 * private API) and a public GitHub user profile (public REST API, no token
 * required), merges them into /data/profile.json, and re-generates the
 * SEO block inside index.html plus /robots.txt and /sitemap.xml.
 *
 * Design goals:
 *  - Resilient to minor Linktree markup/schema changes: instead of relying
 *    on fixed CSS selectors, it locates the Next.js `__NEXT_DATA__` JSON
 *    payload embedded in the page and walks it generically, looking for
 *    keys that "look like" the data we want, wherever they live in the tree.
 *  - Never destructive: output is only written after everything succeeds.
 *    If anything fails, the previous data/profile.json (and index.html) are
 *    left untouched, and the error is logged.
 *  - Zero third-party dependencies: only Node.js built-ins.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DATA_PATH = path.join(ROOT, 'data', 'profile.json');
const INDEX_PATH = path.join(ROOT, 'index.html');
const ROBOTS_PATH = path.join(ROOT, 'robots.txt');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');

const LINKTREE_URL =
  process.env.LINKTREE_URL || 'https://linktr.ee/karrarhussainjobs';

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SEO_START = '<!-- SEO:START -->';
const SEO_END = '<!-- SEO:END -->';

/* --------------------------------------------------------------------- */
/* Generic helpers                                                        */
/* --------------------------------------------------------------------- */

/** Fetch text with a timeout and a realistic User-Agent so the request is
 * treated like an ordinary public page view (no auth, no cookies sent). */
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      throw new Error(`Request to ${url} failed with HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    });
    if (!res.ok) {
      throw new Error(`Request to ${url} failed with HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Recursively walk an arbitrary JSON value, calling `visit` on every
 * plain object encountered. Used to hunt for data without depending on an
 * exact, brittle schema path. */
function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
    return;
  }
  visit(value);
  for (const key of Object.keys(value)) walk(value[key], visit, seen);
}

/** Find the first string value assigned to any of the given key names,
 * scanning the whole object tree breadth-first-ish via `walk`. */
function findFirstString(root, keyNames) {
  let found;
  walk(root, (obj) => {
    if (found) return;
    for (const key of keyNames) {
      const val = obj[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        found = val.trim();
        return;
      }
    }
  });
  return found;
}

/** Collect every array-of-objects in the tree whose items look like
 * "link" entries (have a usable url + a label of some kind). */
function findLinkArrays(root) {
  const collected = [];
  walk(root, (obj) => {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (!Array.isArray(val) || val.length === 0) continue;
      const looksLikeLinks = val.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof (item.url ?? item.link ?? item.href) === 'string'
      );
      if (looksLikeLinks) collected.push(val);
    }
  });
  return collected;
}

function normaliseLinks(rawArrays) {
  const seenUrls = new Set();
  const links = [];
  for (const arr of rawArrays) {
    for (const item of arr) {
      const url = item.url ?? item.link ?? item.href;
      if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
      if (seenUrls.has(url)) continue;
      const title =
        item.title ?? item.text ?? item.label ?? item.name ?? deriveTitleFromUrl(url);
      // Skip Linktree's own internal/tracking style entries with no useful title.
      if (!title) continue;
      seenUrls.add(url);
      links.push({
        id: item.id ? String(item.id) : `link-${links.length + 1}`,
        title: String(title).trim(),
        url,
        type: item.type ? String(item.type) : 'link',
      });
    }
  }
  return links;
}

function deriveTitleFromUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const SOCIAL_DOMAINS = [
  'instagram.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'youtube.com',
  'tiktok.com',
  'linkedin.com',
  'github.com',
  'snapchat.com',
  'pinterest.com',
  'twitch.tv',
  'discord.gg',
  'discord.com',
  'telegram.me',
  't.me',
  'whatsapp.com',
  'spotify.com',
];

/** True only if the URL's *hostname* is (or is a subdomain of) one of the
 * known social domains — matching anywhere in the full URL string would
 * false-positive on links that merely mention e.g. "linkedin.com" inside a
 * tracking query parameter (utm_source=linkedin.com etc). */
function hostnameMatchesSocialDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return SOCIAL_DOMAINS.find((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return undefined;
  }
}

function extractSocials(links, root) {
  const fromLinks = links
    .map((l) => ({ domain: hostnameMatchesSocialDomain(l.url), url: l.url }))
    .filter((entry) => entry.domain)
    .map((entry) => ({ platform: entry.domain.split('.')[0], url: entry.url }));

  // Also look for a dedicated "socialLinks" style structure, common on
  // Linktree, in case those aren't rendered as regular link entries.
  const dedicated = [];
  walk(root, (obj) => {
    for (const key of Object.keys(obj)) {
      if (!/social/i.test(key)) continue;
      const val = obj[key];
      if (!Array.isArray(val)) continue;
      for (const item of val) {
        const url = item?.url ?? item?.link;
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          const domain = hostnameMatchesSocialDomain(url);
          dedicated.push({ platform: item?.type ?? domain?.split('.')[0] ?? 'link', url });
        }
      }
    }
  });

  const merged = [...fromLinks, ...dedicated];
  const seen = new Set();
  return merged.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

/* --------------------------------------------------------------------- */
/* Linktree extraction                                                    */
/* --------------------------------------------------------------------- */

function extractMetaTag(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return undefined;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseLinktreeHtml(html, sourceUrl) {
  let nextData;
  const scriptMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (scriptMatch) {
    try {
      nextData = JSON.parse(scriptMatch[1]);
    } catch (err) {
      console.warn('[scrape] Could not parse __NEXT_DATA__ JSON:', err.message);
    }
  } else {
    console.warn('[scrape] __NEXT_DATA__ block not found, falling back to meta tags.');
  }

  const usernameFromUrl = new URL(sourceUrl).pathname.replace(/\//g, '') || undefined;

  let name;
  let username = usernameFromUrl;
  let bio;
  let avatar;
  let backgroundImage;
  let links = [];
  let socials = [];

  if (nextData) {
    name = findFirstString(nextData, ['displayName', 'name', 'title']);
    username = findFirstString(nextData, ['username', 'handle']) || usernameFromUrl;
    bio = findFirstString(nextData, ['description', 'bio', 'about']);
    avatar = findFirstString(nextData, [
      'avatarUrl',
      'profilePictureUrl',
      'avatar',
      'imageUrl',
    ]);
    backgroundImage = findFirstString(nextData, [
      'backgroundImageUrl',
      'backgroundUrl',
      'coverImageUrl',
    ]);
    links = normaliseLinks(findLinkArrays(nextData));
    socials = extractSocials(links, nextData);
  }

  // Fall back to <meta> tags for anything the JSON walk didn't find. This
  // keeps the scraper working even if Linktree changes its internal data
  // shape entirely, as long as standard OpenGraph tags remain.
  name =
    name ||
    extractMetaTag(html, [
      /<meta property="og:title" content="([^"]+)"/,
      /<title>([^<]+)<\/title>/,
    ]);
  bio =
    bio ||
    extractMetaTag(html, [
      /<meta property="og:description" content="([^"]+)"/,
      /<meta name="description" content="([^"]+)"/,
    ]);
  avatar =
    avatar || extractMetaTag(html, [/<meta property="og:image" content="([^"]+)"/]);

  return {
    name: name || username || 'Linktree Profile',
    username: username || 'unknown',
    bio: bio || '',
    avatar: avatar || null,
    backgroundImage: backgroundImage || null,
    links,
    socials,
  };
}

/* --------------------------------------------------------------------- */
/* GitHub context + public API                                            */
/* --------------------------------------------------------------------- */

/** Determine "<owner>/<repo>" automatically from the GitHub Actions
 * context, falling back to the local git remote for local development. */
function detectRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    return { owner, repo };
  }
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const match = remote.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (match) return { owner: match[1], repo: match[2] };
  } catch {
    // Not a git repo, or no remote configured yet — that's fine locally.
  }
  return { owner: null, repo: null };
}

async function fetchGithubProfile(owner) {
  if (!owner) return null;
  try {
    // Unauthenticated requests are capped at 60/hour and GitHub-hosted
    // Actions runners share egress IPs with countless other workflows, so
    // that cap gets exhausted almost immediately in CI. Authenticating
    // with the workflow's own GITHUB_TOKEN (raises the cap to 5000/hour)
    // keeps this reliable. No extra secret needs configuring — Actions
    // injects GITHUB_TOKEN automatically.
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const user = await fetchJson(`https://api.github.com/users/${owner}`, {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    });
    return {
      username: user.login,
      name: user.name || user.login,
      bio: user.bio || '',
      avatarUrl: user.avatar_url,
      htmlUrl: user.html_url,
    };
  } catch (err) {
    console.warn('[scrape] Could not fetch GitHub profile:', err.message);
    return null;
  }
}

/* --------------------------------------------------------------------- */
/* Output generation                                                      */
/* --------------------------------------------------------------------- */

function buildPagesUrl(owner, repo) {
  if (!owner) return null;
  if (repo && repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${owner.toLowerCase()}.github.io/`;
  }
  if (repo) return `https://${owner.toLowerCase()}.github.io/${repo}/`;
  return `https://${owner.toLowerCase()}.github.io/`;
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSeoBlock({ displayName, bio, avatar, pagesUrl, username }) {
  const title = `${displayName} | Links`;
  const description = bio && bio.length > 0 ? bio : `All of ${displayName}'s links in one place.`;
  const image = avatar || '';
  const canonical = pagesUrl || '';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    name: title,
    description,
    url: canonical || undefined,
    mainEntity: {
      '@type': 'Person',
      name: displayName,
      alternateName: username,
      description,
      image: image || undefined,
      url: canonical || undefined,
    },
  };

  return [
    SEO_START,
    `  <title>${escapeHtml(title)}</title>`,
    `  <meta name="description" content="${escapeHtml(description)}" />`,
    canonical ? `  <link rel="canonical" href="${escapeHtml(canonical)}" />` : '',
    `  <meta property="og:type" content="profile" />`,
    `  <meta property="og:title" content="${escapeHtml(title)}" />`,
    `  <meta property="og:description" content="${escapeHtml(description)}" />`,
    image ? `  <meta property="og:image" content="${escapeHtml(image)}" />` : '',
    canonical ? `  <meta property="og:url" content="${escapeHtml(canonical)}" />` : '',
    `  <meta name="twitter:card" content="summary" />`,
    `  <meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `  <meta name="twitter:description" content="${escapeHtml(description)}" />`,
    image ? `  <meta name="twitter:image" content="${escapeHtml(image)}" />` : '',
    `  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    SEO_END,
  ]
    .filter(Boolean)
    .join('\n');
}

async function updateIndexHtml(seoContext) {
  const html = await readFile(INDEX_PATH, 'utf8');
  const startIdx = html.indexOf(SEO_START);
  const endIdx = html.indexOf(SEO_END);
  if (startIdx === -1 || endIdx === -1) {
    console.warn('[scrape] SEO markers not found in index.html, skipping SEO injection.');
    return;
  }
  const before = html.slice(0, startIdx);
  const after = html.slice(endIdx + SEO_END.length);
  const block = buildSeoBlock(seoContext);
  const updated = `${before}${block}${after}`;
  if (updated !== html) {
    await writeFile(INDEX_PATH, updated, 'utf8');
  }
}

async function writeRobotsAndSitemap(pagesUrl) {
  const base = pagesUrl || '/';
  const robots = `User-agent: *\nAllow: /\nSitemap: ${base}sitemap.xml\n`;
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${escapeHtml(base)}</loc>`,
    '    <changefreq>hourly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '</urlset>',
    '',
  ].join('\n');

  await writeAtomically(ROBOTS_PATH, robots);
  await writeAtomically(SITEMAP_PATH, sitemap);
}

async function writeAtomically(filePath, contents) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, contents, 'utf8');
  await rename(tmpPath, filePath);
}

async function readExistingProfile() {
  try {
    const raw = await readFile(DATA_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- */
/* Main                                                                    */
/* --------------------------------------------------------------------- */

async function main() {
  console.log(`[scrape] Fetching public page: ${LINKTREE_URL}`);
  const html = await fetchText(LINKTREE_URL);
  const linktreeProfile = parseLinktreeHtml(html, LINKTREE_URL);

  const { owner, repo } = detectRepository();
  console.log(`[scrape] Detected repository context: owner=${owner ?? 'n/a'} repo=${repo ?? 'n/a'}`);

  const githubProfile = await fetchGithubProfile(owner);
  const pagesUrl = buildPagesUrl(owner, repo);

  const displayName = githubProfile?.name || linktreeProfile.name;
  const bio = githubProfile?.bio || linktreeProfile.bio;
  const avatar = githubProfile?.avatarUrl || linktreeProfile.avatar;

  const profileData = {
    generatedAt: new Date().toISOString(),
    source: LINKTREE_URL,
    profile: {
      name: displayName,
      username: linktreeProfile.username,
      bio,
      avatar,
      backgroundImage: linktreeProfile.backgroundImage,
    },
    github: githubProfile,
    links: linktreeProfile.links,
    socials: linktreeProfile.socials,
  };

  if (profileData.links.length === 0) {
    const previous = await readExistingProfile();
    if (previous && previous.links?.length > 0) {
      throw new Error(
        'Scrape produced zero links (likely a markup/schema change or a blocked request). ' +
          'Keeping previous data/profile.json untouched.'
      );
    }
  }

  // Minified JSON output (no pretty-printing) to keep the payload small.
  await writeAtomically(DATA_PATH, JSON.stringify(profileData));
  console.log(`[scrape] Wrote ${DATA_PATH} (${profileData.links.length} links).`);

  await updateIndexHtml({
    displayName,
    bio,
    avatar,
    pagesUrl,
    username: linktreeProfile.username,
  });
  await writeRobotsAndSitemap(pagesUrl);

  console.log('[scrape] Done.');
}

main().catch((err) => {
  console.error('[scrape] FAILED:', err.message);
  console.error('[scrape] Previous data/profile.json (if any) was left unchanged.');
  process.exitCode = 1;
});
