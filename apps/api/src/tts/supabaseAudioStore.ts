import type { AudioStore } from './audioStore.ts';

/**
 * Audio in a PUBLIC Supabase Storage bucket.
 *
 * Public, deliberately. Narration is not sensitive — it is read aloud on a
 * street — and signed URLs carry an expiring query string, which breaks two
 * things at once: the service worker's `.mp3` runtime-caching rule (flagged in
 * Plan 1 as matching nothing, and a query string would keep it that way), and
 * the ability to cache a tour for offline use at all, since the URL stored in
 * the tour would expire.
 */
export class SupabaseAudioStore implements AudioStore {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;

  constructor(args: {
    supabaseUrl: string;
    serviceKey: string;
    bucket?: string;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = args.supabaseUrl.replace(/\/+$/, '');
    this.serviceKey = args.serviceKey;
    this.bucket = args.bucket ?? 'tour-audio';
    this.fetchImpl = args.fetch ?? fetch;
  }

  private objectUrl(key: string): string {
    return `${this.baseUrl}/storage/v1/object/${this.bucket}/${key}.mp3`;
  }

  publicUrl(key: string): string {
    return `${this.baseUrl}/storage/v1/object/public/${this.bucket}/${key}.mp3`;
  }

  /**
   * Supabase wants the key in both headers. `Authorization` carries it as a
   * bearer token; `apikey` is what the API gateway in front of Storage checks
   * before the request reaches it at all. Sending only one gets a 401 that
   * looks like a bad key rather than a missing header.
   */
  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceKey}`,
      apikey: this.serviceKey,
    };
  }

  async find(key: string): Promise<string | null> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: 'HEAD',
      headers: this.authHeaders(),
    });
    return res.ok ? this.publicUrl(key) : null;
  }

  async put(key: string, audio: Uint8Array, contentType: string): Promise<string> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': contentType,
        // Content-addressed: the same key always holds the same utterance, so
        // an upload racing another for the same key is a no-op rather than a
        // conflict worth failing over.
        'x-upsert': 'true',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
      // Derived from `fetch` rather than naming `BodyInit`: this workspace
      // compiles without the DOM lib, so DOM globals are not in scope.
      body: audio as unknown as NonNullable<Parameters<typeof fetch>[1]>['body'],
    });

    if (!res.ok) {
      // Never echo the URL or headers: the service-role key is a bearer token
      // and this message reaches logs and the job row.
      const detail = await res.text().catch(() => '');
      throw new Error(`Audio upload failed: ${res.status} ${detail.slice(0, 300)}`);
    }

    return this.publicUrl(key);
  }
}

/**
 * Builds the store from the environment, or returns null when Supabase
 * Storage is not configured.
 *
 * Null rather than throwing: a deployment without storage should still
 * generate tours and fall back to on-device speech, not refuse to start. The
 * synthesis stage skips itself when there is nowhere to put the audio.
 */
export function audioStoreFromEnv(fetchImpl: typeof fetch = fetch): SupabaseAudioStore | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  // Supabase renamed its keys: `sb_secret_…` under SUPABASE_SECRET_KEY is what
  // older docs call the service-role key. Both names accepted so a project
  // created before or after the rename works without editing anything.
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  return new SupabaseAudioStore({ supabaseUrl, serviceKey, fetch: fetchImpl });
}
