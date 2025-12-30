import { CheckCircleOutlined, DeleteOutlined } from '@ant-design/icons';
import { useContext, useState } from 'react';
import styled from 'styled-components';
import { Button, Input, Popconfirm, message } from 'antd';
import { Context } from '../context';
import { getAppUserFromState, getRecipeFromState, getUserFromState } from '../state';
import { RecipeCardProps } from './RecipeCard';
import { CookingLogEntry } from '../types';
import { updateCookingLogEntry, deleteCookingLogEntry } from '../firestore';

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
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const recipe = getRecipeFromState(state, boxId, recipeId);
  const currentUser = getAppUserFromState(state);

  if (!recipe) {
    return null;
  }

  const cookingLog = recipe.cookingLog || [];

  const getUserName = (userId: string): string => {
    const logUser = getUserFromState(state, userId);
    return logUser?.name || 'Someone';
  };

  const canEdit = (entry: CookingLogEntry): boolean => {
    return currentUser?.id === entry.madeBy;
  };

  const handleStartEdit = (actualIndex: number) => {
    setEditingIndex(actualIndex);
  };

  const handleSaveEdit = async (actualIndex: number, newNote: string) => {
    try {
      await updateCookingLogEntry(boxId, recipeId, actualIndex, newNote);
      setEditingIndex(null);
    } catch (error) {
      console.error('Failed to update note:', error);
      message.error('Failed to update note');
    }
  };

  const handleDelete = async (actualIndex: number) => {
    try {
      await deleteCookingLogEntry(boxId, recipeId, actualIndex);
      message.success('Entry deleted');
    } catch (error) {
      console.error('Failed to delete entry:', error);
      message.error('Failed to delete entry');
    }
  };

  if (cookingLog.length === 0) {
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
        {[...cookingLog].reverse().map((entry: CookingLogEntry, displayIndex: number) => {
          const actualIndex = cookingLog.length - 1 - displayIndex;
          const editable = canEdit(entry);
          const isEditing = editingIndex === actualIndex;

          return (
            <LogEntryContainer key={displayIndex}>
              <LogIcon><CheckCircleOutlined /></LogIcon>
              <LogContent>
                <LogMeta>
                  {getUserName(entry.madeBy)} made this on {formatDate(entry.madeAt)}
                </LogMeta>
                {isEditing ? (
                  <NoteInput
                    autoFocus
                    autoSize
                    defaultValue={entry.note || ''}
                    placeholder="Add a note about how it turned out..."
                    onBlur={(e) => handleSaveEdit(actualIndex, e.target.value)}
                    onKeyUp={(e) => {
                      if (e.key === 'Escape') {
                        handleSaveEdit(actualIndex, e.currentTarget.value);
                      }
                    }}
                  />
                ) : entry.note ? (
                  <LogNote
                    $editable={editable}
                    onDoubleClick={editable ? () => handleStartEdit(actualIndex) : undefined}
                  >
                    "{entry.note}"
                  </LogNote>
                ) : editable && (
                  <AddNoteHint onDoubleClick={() => handleStartEdit(actualIndex)}>
                    Double-click to add a note
                  </AddNoteHint>
                )}
              </LogContent>
              {editable && (
                <LogActions>
                  <Popconfirm
                    title="Delete this entry?"
                    onConfirm={() => handleDelete(actualIndex)}
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
