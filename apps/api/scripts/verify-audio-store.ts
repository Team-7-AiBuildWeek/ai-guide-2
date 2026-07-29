/**
 * Proves the audio store works against the real Supabase bucket before the
 * synthesis stage depends on it.
 *
 * Uploads a tiny object, reads it back over the public URL, and reports
 * whether the bucket is actually public — which the service worker's offline
 * caching depends on, and which is easy to get wrong by leaving the bucket
 * private and only noticing when a walk has no audio.
 */
import { audioStoreFromEnv } from '../src/tts/supabaseAudioStore.ts';
import { audioKey } from '../src/tts/audioStore.ts';

const store = audioStoreFromEnv();
if (!store) {
  console.error('Supabase Storage is not configured.');
  console.error('  SUPABASE_URL         https://<ref>.supabase.co');
  console.error('  SUPABASE_SECRET_KEY  the sb_secret_... key');
  process.exit(1);
}

const key = audioKey({ text: 'store smoke test', languageCode: 'sk-SK', voice: 'test' });
const payload = new TextEncoder().encode('not really an mp3, just proving the round trip');

console.log('uploading…');
const url = await store.put(key, payload, 'audio/mpeg');
console.log(`  stored -> ${url}`);

console.log('looking it up…');
const found = await store.find(key);
console.log(`  find() -> ${found ?? 'NOT FOUND'}`);

console.log('fetching the public URL with no credentials…');
const res = await fetch(url);
if (res.ok) {
  const body = await res.text();
  const matches = body === new TextDecoder().decode(payload);
  console.log(`  ${res.status} — content ${matches ? 'matches' : 'DIFFERS'}`);
  console.log('\nBucket is public and readable. Offline audio caching will work.');
} else {
  console.log(`  ${res.status}`);
  console.error('\nThe object uploaded but is NOT publicly readable.');
  console.error('Supabase dashboard -> Storage -> tour-audio -> make the bucket public.');
  console.error('A private bucket means every tour needs signed URLs, which expire and');
  console.error('break both offline caching and any URL stored in a saved tour.');
  process.exit(1);
}

process.exit(0);
