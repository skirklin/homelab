import { CheckCircleOutlined, DeleteOutlined, DiffOutlined, EditOutlined } from '@ant-design/icons';
import { useContext, useState, useEffect, useRef } from 'react';
import styled from 'styled-components';
import { Button, Input, Popconfirm, Rate, Spin, Tooltip } from 'antd';
import { Context } from '../context';
import { getAppUserFromState, getRecipeFromState } from '../state';
import { getRecipeData } from '../storage';
import type { RecipeCardProps } from './RecipeCard';
import { useRecipesBackend } from '@kirkl/shared';
import { useAuth, useFeedback, useUserNames } from '@kirkl/shared';
import type { CookingLogEvent, LifeEntry } from '@homelab/backend';
import { CookingLogDiffModal } from './CookingLogDiffModal';

/** Pull the "notes" text entry out of a unified event row. */
function getNotes(event: CookingLogEvent): string {
  for (const e of event.entries) {
    if (e.name === 'notes' && e.type === 'text') return e.value;
  }
  return '';
}

/**
 * Apply a notes edit to the local copy of an event: replace any existing
 * "notes" text entry, drop it when the value is empty. Preserves any other
 * entries the row may carry.
 */
function withNotes(event: CookingLogEvent, notes: string): CookingLogEvent {
  const filtered = event.entries.filter(
    (e) => !(e.name === 'notes' && e.type === 'text'),
  );
  const trimmed = notes.trim();
  const entries: LifeEntry[] = trimmed
    ? [...filtered, { name: 'notes', type: 'text', value: trimmed }]
    : filtered;
  return { ...event, entries };
}

/**
 * Apply a rating edit to the local copy of an event: replace any existing
 * "rating" number entry, drop it when cleared (null). Keeps the derived
 * `rating` field and entries[] in sync with the post-write row.
 */
function withRating(event: CookingLogEvent, rating: number | null): CookingLogEvent {
  const filtered = event.entries.filter(
    (e) => !(e.name === 'rating' && e.type === 'number'),
  );
  const entries: LifeEntry[] = rating
    ? [...filtered, { name: 'rating', type: 'number', value: rating, unit: 'stars' }]
    : filtered;
  return { ...event, entries, rating: rating ?? undefined };
}

const LogContainer = styled.div`
  margin-top: var(--space-md);
`

const LogTitle = styled.h3`
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 var(--space-sm) 0;
`

const LogList = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`

const LogEntryContainer = styled.div`
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--color-bg-subtle);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
`

const LogIcon = styled.span`
  color: var(--color-primary);
  flex-shrink: 0;
`

const LogContent = styled.div`
  flex: 1;
`

const LogMeta = styled.div`
  color: var(--color-text-secondary);
`

const LogNote = styled.p<{ $editable?: boolean }>`
  margin: var(--space-xs) 0 0 0;
  color: var(--color-text);
  font-style: italic;
  ${props => props.$editable && `
    cursor: pointer;
    &:hover {
      background: var(--color-bg-hover);
      border-radius: var(--radius-sm);
    }
  `}
`

const StarRow = styled(Rate)`
  font-size: var(--font-size-base);
  margin-top: var(--space-xs);
  /* Keep disabled (read-only) stars full-color — they're a display, not a
     greyed-out control. */
  &.ant-rate-disabled .ant-rate-star {
    cursor: default;
  }
`

const AddNoteHint = styled.span`
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  &:hover {
    color: var(--color-primary);
  }
`

const LogActions = styled.div`
  display: flex;
  gap: var(--space-xs);
  flex-shrink: 0;
`

const ActionButton = styled(Button)`
  padding: 0 var(--space-xs);
  height: auto;
  font-size: var(--font-size-sm);
`

const EmptyState = styled.div`
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-style: italic;
`

const NoteInput = styled(Input.TextArea)`
  margin-top: var(--space-xs);
  font-style: italic;
`

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function CookingLog(props: RecipeCardProps) {
  const { message } = useFeedback();
  const { recipeId, boxId } = props;
  const { state } = useContext(Context);
  const { user: authUser } = useAuth();
  const recipesBackend = useRecipesBackend();
  const [events, setEvents] = useState<CookingLogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Draft text of the open note editor (controlled input). Lives in state —
  // not just the DOM — so a star tap can coalesce the in-progress note into
  // its own write (see handleRate).
  const [draft, setDraft] = useState('');
  const [diffEventId, setDiffEventId] = useState<string | null>(null);

  // Serialize all cooking-log writes through one promise chain. The backend's
  // updateCookingLogEvent is a read-modify-write of the full entries[] array,
  // so two overlapping updates to the same entry both read the pre-write row
  // and the second write silently drops the first one's field server-side
  // (note-save-on-blur vs star-tap was the live case). Chaining makes every
  // write read its predecessor's result. The chain swallows rejections so one
  // failed write can't poison later ones; callers get the un-swallowed
  // promise back for their own error handling.
  const updateChain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueUpdate = (eventId: string, patch: { notes?: string; rating?: number | null }): Promise<void> => {
    const run = updateChain.current.then(() => recipesBackend.updateCookingLogEvent(eventId, patch));
    updateChain.current = run.catch(() => undefined);
    return run;
  };

  // Set on mousedown of an entry's star row while that same entry's note
  // editor is open. mousedown fires before the editor's blur, so the blur
  // handler can tell "focus left because of a star tap on this entry" apart
  // from a normal blur — it skips its own save and lets handleRate coalesce
  // notes + rating into ONE updateCookingLogEvent call. One-shot: the blur
  // consumes (clears) it, so an aborted tap (mousedown, no click) can't
  // suppress a later, unrelated save.
  const starTapWhileEditing = useRef<string | null>(null);

  const currentUser = getAppUserFromState(state, authUser?.uid);
  // Pull the live recipe to compare against snapshots. The diff is "snapshot
  // at cook time → current recipe.data", so we re-read on every render —
  // cheap, and stays in sync with edits the user makes in the same session.
  const liveRecipe = getRecipeFromState(state, boxId, recipeId);
  const liveData = liveRecipe ? getRecipeData(liveRecipe) : undefined;

  // Live-subscribe to cooking-log events so "I made it!" clicks, edits,
  // deletes, and writes from another device all update the UI without a
  // manual refresh. Backend fires once with the initial set, then on every
  // matching create/update/delete.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const unsub = recipesBackend.subscribeToCookingLog(boxId, recipeId, (fetchedEvents) => {
      if (cancelled) return;
      setEvents(fetchedEvents);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [boxId, recipeId, recipesBackend]);

  const userNames = useUserNames(events.map((e) => e.createdBy));

  const getUserName = (userId: string): string => userNames.get(userId) || 'Someone';

  const canEdit = (event: CookingLogEvent): boolean => {
    return currentUser?.id === event.createdBy;
  };

  const handleStartEdit = (eventId: string, currentNotes: string) => {
    setDraft(currentNotes);
    setEditingId(eventId);
  };

  const handleSaveEdit = async (eventId: string, newNote: string) => {
    try {
      await enqueueUpdate(eventId, { notes: newNote });
      // Update local state — keep entries[] in sync with the backend so the
      // rerender matches the post-write row exactly.
      setEvents(prev => prev.map(e => (e.id === eventId ? withNotes(e, newNote) : e)));
      setEditingId(null);
    } catch (error) {
      console.error('Failed to update note:', error);
      message.error('Failed to update note');
    }
  };

  // Tapping the star row on your own entry sets the rating immediately
  // (no edit mode); tapping the current star again clears it (antd Rate
  // reports 0 on clear → null at the backend). When that entry's note editor
  // is open, the tap also commits the draft note — coalesced with the rating
  // into a single write so the two fields can never race each other.
  const handleRate = async (eventId: string, value: number) => {
    const rating = value === 0 ? null : value;
    const editingThis = editingId === eventId;
    try {
      if (editingThis) {
        await enqueueUpdate(eventId, { notes: draft, rating });
        setEvents(prev => prev.map(e => (e.id === eventId ? withRating(withNotes(e, draft), rating) : e)));
        setEditingId(null);
      } else {
        await enqueueUpdate(eventId, { rating });
        setEvents(prev => prev.map(e => (e.id === eventId ? withRating(e, rating) : e)));
      }
    } catch (error) {
      console.error('Failed to update rating:', error);
      message.error(editingThis ? 'Failed to save note and rating' : 'Failed to update rating');
    }
  };

  const handleDelete = async (eventId: string) => {
    try {
      await recipesBackend.deleteCookingLogEvent(eventId);
      // Update local state
      setEvents(prev => prev.filter(e => e.id !== eventId));
      message.success('Entry deleted');
    } catch (error) {
      console.error('Failed to delete entry:', error);
      message.error('Failed to delete entry');
    }
  };

  if (loading) {
    return (
      <LogContainer>
        <LogTitle>Cooking Log</LogTitle>
        <Spin size="small" />
      </LogContainer>
    );
  }

  if (events.length === 0) {
    return (
      <LogContainer>
        <LogTitle>Cooking Log</LogTitle>
        <EmptyState>No entries yet. Click "I made it!" after you cook this recipe.</EmptyState>
      </LogContainer>
    );
  }

  return (
    <LogContainer>
      <LogTitle>Cooking Log</LogTitle>
      <LogList>
        {events.map((event) => {
          const editable = canEdit(event);
          const isEditing = editingId === event.id;
          const notes = getNotes(event);

          return (
            <LogEntryContainer key={event.id}>
              <LogIcon><CheckCircleOutlined /></LogIcon>
              <LogContent>
                <LogMeta>
                  {getUserName(event.createdBy)} made this on {formatDate(event.timestamp)}
                </LogMeta>
                {/* Star row: interactive on your own entries (tap to set,
                    tap the same star to clear), read-only display on others'
                    rated entries, hidden on others' unrated ones. */}
                {(editable || event.rating !== undefined) && (
                  <Tooltip title={editable ? 'Rate this cook (tap again to clear)' : undefined}>
                    <span
                      onMouseDown={() => {
                        // mousedown precedes the note editor's blur — flag it
                        // so the blur skips its save and handleRate coalesces
                        // notes + rating into one write.
                        if (editingId === event.id) starTapWhileEditing.current = event.id;
                      }}
                    >
                      <StarRow
                        value={event.rating ?? 0}
                        disabled={!editable}
                        onChange={(v) => handleRate(event.id, v)}
                      />
                    </span>
                  </Tooltip>
                )}
                {isEditing ? (
                  <NoteInput
                    autoFocus
                    autoSize
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Add a note about how it turned out..."
                    onBlur={() => {
                      if (starTapWhileEditing.current === event.id) {
                        // Focus left because of a star tap on this entry:
                        // skip this save — handleRate writes {notes, rating}
                        // as one coalesced update. Consume the flag so an
                        // aborted tap can't suppress the next real blur.
                        starTapWhileEditing.current = null;
                        return;
                      }
                      handleSaveEdit(event.id, draft);
                    }}
                    onKeyUp={(e) => {
                      if (e.key === 'Escape') {
                        handleSaveEdit(event.id, draft);
                      }
                    }}
                  />
                ) : notes ? (
                  <LogNote
                    $editable={editable}
                    onClick={editable ? () => handleStartEdit(event.id, notes) : undefined}
                  >
                    "{notes}"
                  </LogNote>
                ) : editable ? (
                  <AddNoteHint onClick={() => handleStartEdit(event.id, notes)}>
                    Click to add a note
                  </AddNoteHint>
                ) : null}
              </LogContent>
              <LogActions>
                {/* "What changed?" diff button — visible to everyone who can
                    see the entry, not just the entry's author. Snapshot is
                    nullable: rows that predate the feature have no snapshot
                    and the button is disabled with an explanatory tooltip. */}
                {event.recipeSnapshot ? (
                  <Tooltip title="See what changed since you cooked this">
                    <ActionButton
                      type="text"
                      size="small"
                      icon={<DiffOutlined />}
                      onClick={() => setDiffEventId(event.id)}
                    />
                  </Tooltip>
                ) : (
                  <Tooltip title="No snapshot — predates this feature.">
                    <span>
                      <ActionButton
                        type="text"
                        size="small"
                        icon={<DiffOutlined />}
                        disabled
                      />
                    </span>
                  </Tooltip>
                )}
                {editable && !isEditing && (
                  <>
                    <ActionButton
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => handleStartEdit(event.id, notes)}
                    />
                    <Popconfirm
                      title="Delete this entry?"
                      onConfirm={() => handleDelete(event.id)}
                      okText="Delete"
                      cancelText="Cancel"
                    >
                      <ActionButton
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                      />
                    </Popconfirm>
                  </>
                )}
              </LogActions>
            </LogEntryContainer>
          );
        })}
      </LogList>
      {(() => {
        // Render the diff modal outside the entry loop so the entry list
        // doesn't re-mount it on every state change. Single modal driven by
        // diffEventId; null means closed.
        const target = events.find((e) => e.id === diffEventId) ?? null;
        return (
          <CookingLogDiffModal
            open={target !== null}
            onClose={() => setDiffEventId(null)}
            snapshot={target?.recipeSnapshot}
            current={liveData}
            cookedOnLabel={target ? formatDate(target.timestamp) : ""}
          />
        );
      })()}
    </LogContainer>
  );
}

export default CookingLog;
