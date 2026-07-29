import { TourSchema, type Tour } from '@ai-guide/shared';

const DB_NAME = 'ai-guide';
const DB_VERSION = 1;
const STORE_NAME = 'tours';

/** A generated tour with real narration for every stop runs well past
 * localStorage's ~5 MB ceiling, and a quota error mid-walk is unrecoverable
 * — IndexedDB has no such practical limit. `savedAt` is what `loadLatest`
 * orders by. */
interface StoredTour {
  id: string;
  tour: Tour;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function promisifyTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

export async function saveTour(tour: Tour): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const record: StoredTour = { id: tour.id, tour, savedAt: Date.now() };
    tx.objectStore(STORE_NAME).put(record);
    await promisifyTx(tx);
  } finally {
    db.close();
  }
}

/** Parses through `TourSchema` on the way out — the store must not silently
 * hand the player something it can't consume. */
export async function loadTour(id: string): Promise<Tour | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const record = (await promisifyRequest(tx.objectStore(STORE_NAME).get(id))) as
      | StoredTour
      | undefined;
    return record ? TourSchema.parse(record.tour) : null;
  } finally {
    db.close();
  }
}

export async function loadLatest(): Promise<Tour | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const all = (await promisifyRequest(tx.objectStore(STORE_NAME).getAll())) as StoredTour[];
    if (all.length === 0) return null;
    const latest = all.reduce((a, b) => (a.savedAt >= b.savedAt ? a : b));
    return TourSchema.parse(latest.tour);
  } finally {
    db.close();
  }
}

export async function clear(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    await promisifyTx(tx);
  } finally {
    db.close();
  }
}
