/**
 * LinkedIn URL normalization + slug extraction — used for correlation across
 * the pipeline (Apollo bulk-match, GojiBerry dedup, scan-log matching).
 *
 * Canonical form: `http://linkedin.com/in/<slug>` (no protocol casing issues,
 * no subdomain, no trailing slash, no query, no fragment).
 */

/**
 * Normalize a LinkedIn URL to a canonical form. Non-LinkedIn URLs return the
 * trimmed-and-lowercased input unchanged (for debuggability).
 */
export function normalizeLinkedInUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim().toLowerCase();
  const match = trimmed.match(/linkedin\.com(\/[^?#]*)?/);
  if (!match) return trimmed;
  const pathPart = (match[1] ?? '').replace(/\/+$/, '');
  return `http://linkedin.com${pathPart}`;
}

/**
 * Extract the LinkedIn slug (e.g. `jane-doe-123`) from a profile URL.
 * Returns null if the URL doesn't look like a `/in/<slug>` LinkedIn profile URL.
 *
 * Useful as a search key: stable across https/http, www/no-www, trailing-slash,
 * and query variations — unlike the full URL.
 */
export function extractLinkedInSlug(url: string): string | null {
  if (!url) return null;
  const match = url.toLowerCase().match(/linkedin\.com\/in\/([a-z0-9-_%]+)/i);
  return match ? match[1] : null;
}
