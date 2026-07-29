import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LANGUAGES, type GenerateRequest } from '@ai-guide/shared';
import { GenerateScreen } from './GenerateScreen';

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText('What do you want to see?') as HTMLTextAreaElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /generate my tour/i }) as HTMLButtonElement;
}

describe('GenerateScreen', () => {
  it('disables submit while the profile text is empty, and enables it once typed', () => {
    render(<GenerateScreen onGenerate={vi.fn()} />);

    expect(submitButton().disabled).toBe(true);

    fireEvent.change(textarea(), { target: { value: 'brutalist architecture' } });

    expect(submitButton().disabled).toBe(false);
  });

  it('a chip appends its text into the textarea rather than replacing form state', () => {
    render(<GenerateScreen onGenerate={vi.fn()} />);

    fireEvent.change(textarea(), { target: { value: 'I love markets' } });
    fireEvent.click(screen.getByText('brutalist architecture'));

    expect(textarea().value).toBe('I love markets brutalist architecture');
  });

  it('a chip on an empty textarea sets the text directly, with no leading space', () => {
    render(<GenerateScreen onGenerate={vi.fn()} />);

    fireEvent.click(screen.getByText("somewhere my kids won't get bored"));

    expect(textarea().value).toBe("somewhere my kids won't get bored");
  });

  it('clicking a chip does not itself submit or select a category — it only edits the textarea', () => {
    const onGenerate = vi.fn();
    render(<GenerateScreen onGenerate={onGenerate} />);

    fireEvent.click(screen.getByText('food, but not tourist traps'));

    expect(onGenerate).not.toHaveBeenCalled();
    // Still just free text in the one textarea — no separate category state
    // is exposed anywhere in the form.
    expect(textarea().value).toBe('food, but not tourist traps');
  });

  it('offers all seven supported languages', () => {
    render(<GenerateScreen onGenerate={vi.fn()} />);

    const select = screen.getByRole('combobox', { name: /language/i }) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);

    expect(optionValues).toEqual([...LANGUAGES]);
  });

  it('submits a GenerateRequest built from the form fields', () => {
    const onGenerate = vi.fn();
    render(<GenerateScreen onGenerate={onGenerate} />);

    fireEvent.change(textarea(), { target: { value: '  brutalist architecture  ' } });
    fireEvent.change(screen.getByRole('combobox', { name: /language/i }), {
      target: { value: 'nl' },
    });
    fireEvent.change(screen.getByPlaceholderText(/grumpy local historian/i), {
      target: { value: 'a sarcastic tour guide' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: /budget/i }), {
      target: { value: '90' },
    });

    fireEvent.click(submitButton());

    expect(onGenerate).toHaveBeenCalledTimes(1);
    const request = onGenerate.mock.calls[0][0] as GenerateRequest;
    expect(request).toEqual({
      city: 'Bratislava',
      profileText: 'brutalist architecture',
      language: 'nl',
      persona: 'a sarcastic tour guide',
      budgetMin: 90,
    });
  });

  it('does not submit while the profile text is empty, even if the button is clicked', () => {
    const onGenerate = vi.fn();
    render(<GenerateScreen onGenerate={onGenerate} />);

    fireEvent.click(submitButton());

    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('renders a passed-in error message', () => {
    render(<GenerateScreen onGenerate={vi.fn()} error="Wrong passphrase. Please try again." />);

    expect(screen.getByRole('alert').textContent).toMatch(/wrong passphrase/i);
  });
});

function passphraseField(): HTMLInputElement {
  return screen.getByLabelText(/passphrase/i) as HTMLInputElement;
}

describe('GenerateScreen — passphrase', () => {
  // Replaces a window.prompt. iOS Safari can suppress prompts in standalone
  // PWA mode — the mode you are in after adding this to a home screen for a
  // walk — and a dismissed prompt aborted silently, on a street, with no
  // laptop. An in-form field cannot be suppressed and cannot fail silently.
  it('does not ask when a passphrase is already stored', () => {
    render(<GenerateScreen onGenerate={vi.fn()} />);
    expect(screen.queryByLabelText(/passphrase/i)).toBeNull();
  });

  it('asks when one is needed', () => {
    render(<GenerateScreen onGenerate={vi.fn()} needsPassphrase />);
    expect(screen.getByLabelText(/passphrase/i)).toBeTruthy();
  });

  it('keeps submit disabled until the passphrase is filled in', () => {
    render(<GenerateScreen onGenerate={vi.fn()} needsPassphrase />);

    fireEvent.change(textarea(), { target: { value: 'baroque' } });
    expect(submitButton().disabled).toBe(true);

    fireEvent.change(passphraseField(), { target: { value: 'hunter2' } });
    expect(submitButton().disabled).toBe(false);
  });

  it('hands the passphrase to onGenerate alongside the request', () => {
    const onGenerate = vi.fn();
    render(<GenerateScreen onGenerate={onGenerate} needsPassphrase />);

    fireEvent.change(textarea(), { target: { value: 'baroque' } });
    fireEvent.change(passphraseField(), { target: { value: 'hunter2' } });
    fireEvent.click(submitButton());

    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ profileText: 'baroque' }),
      'hunter2',
    );
  });

  it('masks the field so it is not readable over a shoulder', () => {
    render(<GenerateScreen onGenerate={vi.fn()} needsPassphrase />);
    expect(screen.getByLabelText(/passphrase/i).getAttribute('type')).toBe('password');
  });
});
