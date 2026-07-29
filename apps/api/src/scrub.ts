/**
 * Removes credential-looking query parameters from any text about to be
 * persisted, logged, or shown to a user.
 *
 * The redacting fetch in `stages/routing/mapbox.ts` is the primary defence —
 * it keeps the token out of cassette keys and filenames. This is the second
 * one, and it exists because a defect proved it necessary: when the service
 * was wired with the non-redacting fetch, the resulting cassette-miss error
 * carried a full Mapbox URL into `jobs.error`, where it was written to the
 * database and rendered in the browser.
 *
 * An error message is exactly where a URL with a credential in it ends up,
 * so scrubbing at the boundary is worth doing even once the upstream bug is
 * fixed — the next credential in a query string will not announce itself.
 */
const SENSITIVE_PARAMS = ['access_token', 'api_key', 'apikey', 'key', 'token', 'password'];

const PATTERN = new RegExp(`\\b(${SENSITIVE_PARAMS.join('|')})=([^&\\s"']+)`, 'gi');

export function scrubSecrets(text: string): string {
  return text.replace(PATTERN, (_match, name: string) => `${name}=REDACTED`);
}
