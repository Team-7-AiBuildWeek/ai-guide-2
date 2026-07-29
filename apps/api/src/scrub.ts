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

/**
 * Credentials recognisable by shape alone, for when they appear without a
 * `name=` in front of them — a bare token in a message, a JSON body, a stack
 * frame.
 *
 * Twice now a key has escaped through an error string in this project, so
 * this is the second net rather than a theoretical one.
 */
const BARE_TOKENS: { label: string; pattern: RegExp }[] = [
  { label: 'GOOGLE_API_KEY', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'ANTHROPIC_API_KEY', pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}/g },
  { label: 'SUPABASE_SECRET_KEY', pattern: /\bsb_secret_[0-9A-Za-z_-]{20,}/g },
  { label: 'MAPBOX_TOKEN', pattern: /\b(?:pk|sk)\.eyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+/g },
  { label: 'POSTGRES_URL', pattern: /\bpostgres(?:ql)?:\/\/[^\s"']+/g },
];

export function scrubSecrets(text: string): string {
  let out = text.replace(PATTERN, (_match, name: string) => `${name}=REDACTED`);
  for (const { label, pattern } of BARE_TOKENS) {
    out = out.replace(pattern, `<${label}:REDACTED>`);
  }
  return out;
}
