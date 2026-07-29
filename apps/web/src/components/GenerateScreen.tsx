import { useState } from 'react';
import { LANGUAGES, type GenerateRequest, type Language } from '@ai-guide/shared';

// Prototype scope is one city (see apps/api/src/config/cities.ts) — no city
// picker until there's more than one to choose from.
const CITY = 'Bratislava';

const BUDGET_OPTIONS_MIN = [30, 60, 90] as const;

/**
 * These write into the textarea; they are not filters, categories, or
 * selectable options. Someone who already knows what they want types it in
 * their own words — these exist only to nudge someone who doesn't know
 * where to start. A chip that set a category instead of appending text
 * would defeat the free-text personalisation this product is built on.
 */
const EXAMPLE_CHIPS = [
  'brutalist architecture',
  "somewhere my kids won't get bored",
  'food, but not tourist traps',
];

export interface GenerateScreenProps {
  onGenerate: (request: GenerateRequest, passphrase?: string) => void;
  /** Surfaced from a failed previous attempt — e.g. a wrong passphrase. */
  error?: string | null;
  /**
   * Show a passphrase field, because none is stored yet (or the stored one was
   * rejected).
   *
   * This used to be a `window.prompt`, which is the wrong tool twice over:
   * iOS Safari can suppress prompts entirely in standalone PWA mode — which is
   * precisely the mode someone is in after adding this to their home screen for
   * a walk — and a dismissed prompt silently aborts with no feedback at all.
   * On a street, with no laptop, that is unrecoverable.
   */
  needsPassphrase?: boolean;
}

export function GenerateScreen({
  onGenerate,
  error = null,
  needsPassphrase = false,
}: GenerateScreenProps) {
  const [profileText, setProfileText] = useState('');
  const [language, setLanguage] = useState<Language>('en');
  const [persona, setPersona] = useState('');
  const [budgetMin, setBudgetMin] = useState<number>(60);
  const [passphrase, setPassphrase] = useState('');

  const canSubmit =
    profileText.trim().length > 0 && (!needsPassphrase || passphrase.trim().length > 0);

  function appendExample(text: string) {
    setProfileText((prev) => (prev.length === 0 ? text : `${prev} ${text}`));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onGenerate(
      {
        city: CITY,
        profileText: profileText.trim(),
        language,
        persona: persona.trim(),
        budgetMin,
      },
      needsPassphrase ? passphrase.trim() : undefined,
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex h-dvh flex-col gap-4 overflow-y-auto bg-slate-900 px-6 py-8 text-white"
    >
      <h1 className="text-2xl font-semibold">Tell us about your walk</h1>
      <p className="text-sm text-slate-400">{CITY} · in your own words</p>

      <label className="flex flex-col gap-1 text-sm font-medium">
        What do you want to see?
        <textarea
          aria-label="What do you want to see?"
          value={profileText}
          onChange={(e) => setProfileText(e.target.value)}
          placeholder="e.g. I love brutalist architecture and hate crowds"
          rows={4}
          className="rounded-lg bg-slate-800 p-3 text-sm font-normal text-white placeholder:text-slate-500"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        {EXAMPLE_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => appendExample(chip)}
            className="rounded-full bg-slate-700 px-3 py-1.5 text-xs"
          >
            {chip}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Language
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          className="rounded bg-slate-800 p-2 font-normal text-white"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Persona <span className="font-normal text-slate-400">(optional — who's telling it)</span>
        <input
          type="text"
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder="e.g. a grumpy local historian"
          className="rounded bg-slate-800 p-2 font-normal text-white placeholder:text-slate-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        Budget
        <select
          value={budgetMin}
          onChange={(e) => setBudgetMin(Number(e.target.value))}
          className="rounded bg-slate-800 p-2 font-normal text-white"
        >
          {BUDGET_OPTIONS_MIN.map((min) => (
            <option key={min} value={min}>
              {min} minutes
            </option>
          ))}
        </select>
      </label>

      {needsPassphrase && (
        <label className="flex flex-col gap-1 text-sm font-medium">
          Passphrase
          <span className="text-xs font-normal text-slate-400">
            Asked once per device, then remembered
          </span>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
            className="rounded bg-slate-800 p-2 font-normal text-white placeholder:text-slate-500"
          />
        </label>
      )}

      {error !== null && (
        <p role="alert" className="text-sm font-medium text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="mt-auto rounded-full bg-blue-600 px-8 py-4 text-lg font-semibold disabled:opacity-50"
      >
        Generate my tour
      </button>
    </form>
  );
}
