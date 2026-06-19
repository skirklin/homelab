/**
 * Frontend adapter: turn a normalized `SessionRun` into renderable journal
 * blocks (one labeled prompt + value per captured item), ordered by the View's
 * item order, with prompt text pulled from the vocab rows.
 *
 * This is the READ-side bridge for the dual-shape cutover: a fat `*_session`
 * event and its per-item equivalent both normalize to the same `SessionRun`
 * (via `normalizeSessionRuns`), and this maps that run to the same blocks — so
 * the Journal renders them identically. Pure (no React).
 */
import type {
  LifeEntry,
  LifeManifestTrackable,
  LifeView,
  SessionRun,
  SessionView,
} from "@homelab/backend";

/** A single rendered prompt/value pair within a journal run card. */
export interface JournalBlock {
  /** Stable React key (the vocab id). */
  vocabId: string;
  /** Prompt/label text shown above the value. */
  prompt: string;
  /** `text` → free-text value; `rating` → a 1..scale pill. */
  kind: "text" | "rating";
  /** For `text`. */
  text?: string;
  /** For `rating`. */
  value?: number;
  scale?: number;
}

/** A run reduced to an ordered, renderable block list. */
export interface JournalRun {
  id: string;
  view: SessionView;
  timestamp: Date;
  blocks: JournalBlock[];
}

/** Pull the renderable block for one captured vocab item, or null when empty. */
function blockFor(
  vocabId: string,
  entries: LifeEntry[],
  prompt: string,
): JournalBlock | null {
  // Rating: a number entry with unit "rating".
  const rating = entries.find(
    (e): e is Extract<LifeEntry, { type: "number" }> => e.type === "number" && e.unit === "rating",
  );
  if (rating) {
    return { vocabId, prompt, kind: "rating", value: rating.value, scale: rating.scale ?? 5 };
  }
  // Text: the first non-empty text entry (name-agnostic — `note` for new
  // per-item, the legacy prompt name for fat history normalized to `note`).
  const text = entries.find(
    (e): e is Extract<LifeEntry, { type: "text" }> => e.type === "text" && e.value.trim().length > 0,
  );
  if (text) {
    return { vocabId, prompt, kind: "text", text: text.value };
  }
  return null;
}

/**
 * Map a run to an ordered `JournalRun`. Item order + prompt text come from the
 * matching View's `items` (a `capture` item names a `trackableId`) and the
 * vocab row's `prompt`/`label`. Any captured vocab id not in the view (e.g. a
 * legacy `mood` that the live view no longer prompts) is appended after the
 * view-ordered blocks so nothing is dropped.
 */
export function toJournalRun(
  run: SessionRun,
  views: LifeView[],
  vocab: Map<string, LifeManifestTrackable>,
): JournalRun {
  const view = views.find((v) => v.id === run.view);
  const promptFor = (vocabId: string): string => {
    const row = vocab.get(vocabId);
    return row?.prompt ?? row?.label ?? vocabId;
  };

  const ordered: string[] = [];
  const seen = new Set<string>();
  if (view) {
    for (const item of view.items) {
      if (item.kind === "capture" && run.values[item.trackableId]) {
        ordered.push(item.trackableId);
        seen.add(item.trackableId);
      }
    }
  }
  // Any captured ids not enumerated by the view (defensive — degraded data).
  for (const vocabId of Object.keys(run.values)) {
    if (!seen.has(vocabId)) ordered.push(vocabId);
  }

  const blocks: JournalBlock[] = [];
  for (const vocabId of ordered) {
    for (const item of run.values[vocabId]) {
      const b = blockFor(vocabId, item.entries, promptFor(vocabId));
      if (b) blocks.push(b);
    }
  }
  return { id: run.id, view: run.view, timestamp: run.timestamp, blocks };
}
