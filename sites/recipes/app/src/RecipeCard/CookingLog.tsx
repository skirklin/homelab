import { CheckCircleOutlined, DeleteOutlined } from '@ant-design/icons';
import { useContext, useState, useEffect } from 'react';
import styled from 'styled-components';
import { Button, Input, Popconfirm, message, Spin } from 'antd';
import { Context } from '../context';
import { getAppUserFromState, getUserFromState } from '../state';
import type { RecipeCardProps } from './RecipeCard';
import { getCookingLogEvents, updateCookingLogEvent, deleteCookingLogEvent } from '../firestore';
import { useAuth, type Event } from '@kirkl/shared';

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
  const { recipeId, boxId } = props;
  const { state } = useContext(Context);
  const { user: authUser } = useAuth();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  const currentUser = getAppUserFromState(state, authUser?.uid);

  // Fetch events from subcollection
  useEffect(() => {
    let cancelled = false;

    const fetchEvents = async () => {
      setLoading(true);
      try {
        const fetchedEvents = await getCookingLogEvents(boxId, recipeId);
        if (!cancelled) {
          setEvents(fetchedEvents);
        }
      } catch (error) {
        console.error('Failed to fetch cooking log:', error);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchEvents();
    return () => { cancelled = true; };
  }, [boxId, recipeId]);

  const getUserName = (userId: string): string => {
    const logUser = getUserFromState(state, userId);
    return logUser?.name || 'Someone';
  };

  const canEdit = (event: Event): boolean => {
    return currentUser?.id === event.createdBy;
  };

  const handleStartEdit = (eventId: string) => {
    setEditingId(eventId);
  };

  const handleSaveEdit = async (eventId: string, newNote: string) => {
    try {
      await updateCookingLogEvent(boxId, eventId, newNote);
      // Update local state
      setEvents(prev => prev.map(e =>
        e.id === eventId
          ? { ...e, data: { ...e.data, notes: newNote.trim() || undefined } }
          : e
      ));
      setEditingId(null);
    } catch (error) {
      console.error('Failed to update note:', error);
      message.error('Failed to update note');
    }
  };

  const handleDelete = async (eventId: string) => {
    try {
      await deleteCookingLogEvent(boxId, eventId);
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
        {events.map((event: Event) => {
          const editable = canEdit(event);
          const isEditing = editingId === event.id;

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
                    defaultValue={(event.data.notes as string) || ''}
                    placeholder="Add a note about how it turned out..."
                    onBlur={(e) => handleSaveEdit(event.id, e.target.value)}
                    onKeyUp={(e) => {
                      if (e.key === 'Escape') {
                        handleSaveEdit(event.id, e.currentTarget.value);
                      }
                    }}
                  />
                ) : event.data.notes ? (
                  <LogNote
                    $editable={editable}
                    onDoubleClick={editable ? () => handleStartEdit(event.id) : undefined}
                  >
                    "{String(event.data.notes)}"
                  </LogNote>
                ) : editable ? (
                  <AddNoteHint onDoubleClick={() => handleStartEdit(event.id)}>
                    Double-click to add a note
                  </AddNoteHint>
                ) : null}
              </LogContent>
              {editable && (
                <LogActions>
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
                </LogActions>
              )}
            </LogEntryContainer>
          );
        })}
      </LogList>
    </LogContainer>
  );
}

export default CookingLog;
