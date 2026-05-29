import { CheckCircleOutlined, DeleteOutlined, DiffOutlined, EditOutlined } from '@ant-design/icons';
import { useContext, useState, useEffect } from 'react';
import styled from 'styled-components';
import { Button, Input, Popconfirm, Spin, Tooltip } from 'antd';
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
  const [diffEventId, setDiffEventId] = useState<string | null>(null);

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

  const handleStartEdit = (eventId: string) => {
    setEditingId(eventId);
  };

  const handleSaveEdit = async (eventId: string, newNote: string) => {
    try {
      await recipesBackend.updateCookingLogEvent(eventId, newNote);
      // Update local state — keep entries[] in sync with the backend so the
      // rerender matches the post-write row exactly.
      setEvents(prev => prev.map(e => (e.id === eventId ? withNotes(e, newNote) : e)));
      setEditingId(null);
    } catch (error) {
      console.error('Failed to update note:', error);
      message.error('Failed to update note');
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
                {isEditing ? (
                  <NoteInput
                    autoFocus
                    autoSize
                    defaultValue={notes}
                    placeholder="Add a note about how it turned out..."
                    onBlur={(e) => handleSaveEdit(event.id, e.target.value)}
                    onKeyUp={(e) => {
                      if (e.key === 'Escape') {
                        handleSaveEdit(event.id, e.currentTarget.value);
                      }
                    }}
                  />
                ) : notes ? (
                  <LogNote
                    $editable={editable}
                    onClick={editable ? () => handleStartEdit(event.id) : undefined}
                  >
                    "{notes}"
                  </LogNote>
                ) : editable ? (
                  <AddNoteHint onClick={() => handleStartEdit(event.id)}>
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
                      onClick={() => handleStartEdit(event.id)}
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
