/**
 * Regression tests for the note-save vs star-tap lost-update race.
 *
 * The note editor saves on blur; tapping the star row while the editor is
 * open fires both the blur-save and the rating change near-simultaneously.
 * The PocketBase adapter's updateCookingLogEvent is a getOne-then-write of
 * the full entries[] array, so two overlapping calls both read the
 * pre-write entries and the second write silently drops the first one's
 * field server-side (local state showed both — the loss only surfaced on
 * the next refetch).
 *
 * The stub backend below emulates that read-modify-write window: it
 * snapshots the stored entries synchronously on call, then writes after a
 * delay. Two overlapping calls therefore both compute from the pre-write
 * state — exactly the interleaving that lost the note. CookingLog must
 * prevent it by (a) serializing updates through a promise chain and
 * (b) coalescing a star tap on an actively-edited entry into one
 * updateCookingLogEvent({ notes, rating }) call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CookingLogEvent, LifeEntry, RecipesBackend } from '@homelab/backend';
import { Context, initState } from '../context';
import type { AppState } from '../types';
import { Visibility } from '../types';
import CookingLog from './CookingLog';

// Swappable per-test backend behind the mocked useRecipesBackend hook.
const backendRef: { current: RecipesBackend } = {
  current: undefined as unknown as RecipesBackend,
};

vi.mock('@kirkl/shared', () => ({
  useRecipesBackend: () => backendRef.current,
  useAuth: () => ({ user: { uid: 'u1' } }),
  useFeedback: () => ({ message: { error: () => {}, success: () => {} } }),
  useUserNames: () => new Map([['u1', 'Scott']]),
}));

function makeEvent(id: string, entries: LifeEntry[] = []): CookingLogEvent {
  return {
    id,
    subjectId: 'recipe1',
    timestamp: new Date('2026-01-01T12:00:00Z'),
    entries,
    createdBy: 'u1',
    created: '',
    updated: '',
  };
}

/**
 * Stub RecipesBackend whose updateCookingLogEvent mirrors the real
 * adapter's race window: read entries now, write the patched copy after
 * `readToWriteDelayMs`. Overlapping calls both read pre-write state, so a
 * second write computed before the first lands clobbers it.
 */
function makeRacyBackend(initialEvents: CookingLogEvent[], readToWriteDelayMs = 25) {
  const store = new Map<string, LifeEntry[]>(
    initialEvents.map((e) => [e.id, [...e.entries]]),
  );
  const calls: Array<{ eventId: string; patch: { notes?: string; rating?: number | null } }> = [];

  const backend = {
    subscribeToCookingLog(
      _boxId: string,
      _recipeId: string,
      cb: (events: CookingLogEvent[]) => void,
    ) {
      cb(initialEvents);
      return () => {};
    },
    async updateCookingLogEvent(
      eventId: string,
      patch: { notes?: string; rating?: number | null },
    ) {
      calls.push({ eventId, patch });
      // getOne: snapshot the entries as they are RIGHT NOW.
      const snapshot = [...(store.get(eventId) ?? [])];
      // Window in which another overlapping update can also read.
      await new Promise((r) => setTimeout(r, readToWriteDelayMs));
      // Write: full entries[] computed from the (possibly stale) snapshot.
      let entries = snapshot;
      if (patch.notes !== undefined) {
        entries = entries.filter((e) => !(e.name === 'notes' && e.type === 'text'));
        const trimmed = patch.notes.trim();
        if (trimmed) entries = [...entries, { name: 'notes', type: 'text', value: trimmed }];
      }
      if (patch.rating !== undefined) {
        entries = entries.filter((e) => !(e.name === 'rating' && e.type === 'number'));
        if (patch.rating) {
          entries = [...entries, { name: 'rating', type: 'number', value: patch.rating, unit: 'stars' }];
        }
      }
      store.set(eventId, entries);
    },
  } as unknown as RecipesBackend;

  return { backend, store, calls };
}

function renderCookingLog() {
  const state: AppState = {
    ...initState(),
    users: new Map([
      ['u1', {
        id: 'u1',
        name: 'Scott',
        visibility: Visibility.private,
        boxes: [],
        lastSeen: new Date(),
        newSeen: new Date(),
        lastSeenUpdateVersion: 0,
      }],
    ]),
  };
  return render(
    <Context.Provider value={{ state, dispatch: () => state }}>
      <CookingLog recipeId="recipe1" boxId="box1" />
    </Context.Provider>,
  );
}

function notesOf(entries: LifeEntry[]): string | undefined {
  const e = entries.find((x) => x.name === 'notes' && x.type === 'text');
  return e && 'value' in e ? (e.value as string) : undefined;
}

function ratingOf(entries: LifeEntry[]): number | undefined {
  const e = entries.find((x) => x.name === 'rating' && x.type === 'number');
  return e && 'value' in e ? (e.value as number) : undefined;
}

describe('CookingLog — note-save vs star-tap race', () => {
  beforeEach(() => {
    backendRef.current = undefined as unknown as RecipesBackend;
  });

  it('keeps both the note and the rating when a star is tapped mid-edit', async () => {
    const { backend, store } = makeRacyBackend([makeEvent('ev1')]);
    backendRef.current = backend;
    renderCookingLog();

    const user = userEvent.setup();
    await user.click(await screen.findByText('Click to add a note'));
    const textarea = await screen.findByPlaceholderText('Add a note about how it turned out...');
    await user.type(textarea, 'needed more salt');

    // Tap the 4th star while the note editor is open and dirty. Without the
    // fix this fires blur-save({notes}) and rate({rating}) as two overlapping
    // read-modify-write updates and the rating write drops the note.
    const stars = screen.getAllByRole('radio');
    await user.click(stars[3]);

    await waitFor(() => {
      const entries = store.get('ev1')!;
      expect(ratingOf(entries)).toBe(4);
      expect(notesOf(entries)).toBe('needed more salt');
    });
  });

  it('coalesces the mid-edit star tap into a single {notes, rating} update', async () => {
    const { backend, store, calls } = makeRacyBackend([makeEvent('ev1')]);
    backendRef.current = backend;
    renderCookingLog();

    const user = userEvent.setup();
    await user.click(await screen.findByText('Click to add a note'));
    const textarea = await screen.findByPlaceholderText('Add a note about how it turned out...');
    await user.type(textarea, 'great with honey');
    await user.click(screen.getAllByRole('radio')[4]);

    await waitFor(() => {
      expect(notesOf(store.get('ev1')!)).toBe('great with honey');
    });
    expect(calls).toEqual([
      { eventId: 'ev1', patch: { notes: 'great with honey', rating: 5 } },
    ]);
    // The coalesced save also closes the editor and renders the saved note.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Add a note about how it turned out...')).toBeNull();
      expect(screen.getByText('"great with honey"')).toBeInTheDocument();
    });
  });

  it('serializes back-to-back updates so the second reads the first one’s write', async () => {
    // Escape-save followed by a star tap before the save's write lands. The
    // wide 200ms read-to-write window guarantees the two updates overlap
    // unless CookingLog queues them (or coalesces) — under the old code the
    // rating write was computed from pre-notes entries and dropped the note.
    const { backend, store } = makeRacyBackend([makeEvent('ev1')], 200);
    backendRef.current = backend;
    renderCookingLog();

    const user = userEvent.setup();
    // Save a note via the editor (blur by pressing Escape), then immediately
    // tap a star before the note write's delay window has elapsed.
    await user.click(await screen.findByText('Click to add a note'));
    const textarea = await screen.findByPlaceholderText('Add a note about how it turned out...');
    await user.type(textarea, 'crispy edges');
    await user.keyboard('{Escape}');
    await user.click(screen.getAllByRole('radio')[2]);

    await waitFor(() => {
      const entries = store.get('ev1')!;
      expect(notesOf(entries)).toBe('crispy edges');
      expect(ratingOf(entries)).toBe(3);
    });
  });
});
