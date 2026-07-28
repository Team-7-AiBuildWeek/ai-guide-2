import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserLocation } from './browser';
import type { Fix } from './types';

function installFakeGeolocation() {
  let nextId = 1;
  const watchers = new Map<number, (pos: unknown) => void>();
  const errorHandlers = new Map<number, (err: { code: number; message: string }) => void>();

  const geolocation = {
    watchPosition: vi.fn(
      (
        success: (pos: unknown) => void,
        error?: (err: { code: number; message: string }) => void,
        _options?: PositionOptions,
      ) => {
        const id = nextId++;
        watchers.set(id, success);
        if (error) errorHandlers.set(id, error);
        return id;
      },
    ),
    clearWatch: vi.fn((id: number) => {
      watchers.delete(id);
      errorHandlers.delete(id);
    }),
  };

  vi.stubGlobal('navigator', { geolocation });

  return {
    geolocation,
    emit(coords: { latitude: number; longitude: number; accuracy: number }, ts = 5000) {
      for (const w of watchers.values()) {
        w({ coords, timestamp: ts });
      }
    },
    emitError(error: { code: number; message: string }) {
      for (const h of errorHandlers.values()) {
        h(error);
      }
    },
    watcherCount: () => watchers.size,
  };
}

describe('BrowserLocation', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('maps a GeolocationPosition to a Fix', () => {
    const fake = installFakeGeolocation();
    const fixes: Fix[] = [];
    const provider = new BrowserLocation();
    provider.start((f) => fixes.push(f));

    fake.emit({ latitude: 52.3731, longitude: 4.8936, accuracy: 14 }, 5000);

    expect(fixes).toEqual([
      { lat: 52.3731, lng: 4.8936, accuracyM: 14, timestamp: 5000 },
    ]);
  });

  it('requests high accuracy and disables caching', () => {
    const fake = installFakeGeolocation();
    new BrowserLocation().start(() => {});

    const options = fake.geolocation.watchPosition.mock.calls[0][2];
    expect(options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
  });

  it('clears the watch on stop', () => {
    const fake = installFakeGeolocation();
    const provider = new BrowserLocation();
    provider.start(() => {});
    expect(fake.watcherCount()).toBe(1);

    provider.stop();
    expect(fake.watcherCount()).toBe(0);
  });

  it('stop is safe to call before start', () => {
    installFakeGeolocation();
    expect(() => new BrowserLocation().stop()).not.toThrow();
  });

  it('reports a permission-denied error through the onError callback', () => {
    const fake = installFakeGeolocation();
    const messages: string[] = [];
    const provider = new BrowserLocation((m) => messages.push(m));
    provider.start(() => {});

    fake.emitError({ code: 1, message: 'User denied Geolocation' });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/denied/i);
  });

  it('reports a non-permission GPS failure with a message distinguishable from permission-denied', () => {
    const fake = installFakeGeolocation();
    const messages: string[] = [];
    const provider = new BrowserLocation((m) => messages.push(m));
    provider.start(() => {});

    fake.emitError({ code: 2, message: 'Position unavailable' });

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toMatch(/denied/i);
    expect(messages[0]).not.toBe('');
  });
});
