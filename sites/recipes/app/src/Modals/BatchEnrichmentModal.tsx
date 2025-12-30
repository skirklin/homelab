import { CheckOutlined, CloseOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Checkbox, Modal, Tag } from 'antd';
import { useContext, useMemo, useState } from 'react';
import styled from 'styled-components';
import { Context } from '../context';
import { applyEnrichment, rejectEnrichment } from '../firestore';
import { RecipeEntry } from '../storage';
import { BoxId, RecipeId } from '../types';
import { Section, SectionLabel, SuggestedDescription, TagsContainer, Reasoning } from './EnrichmentStyles';

const EnrichmentList = styled.div`
  max-height: 60vh;
  overflow-y: auto;
`

const EnrichmentItem = styled.div<{ $selected: boolean }>`
  border: 1px solid ${props => props.$selected ? '#9370db' : 'var(--color-border)'};
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-sm);
  background: ${props => props.$selected ? 'rgba(147, 112, 219, 0.05)' : 'var(--color-bg)'};
  transition: all 0.2s ease;
`

const ItemHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
`

const RecipeName = styled.span`
  font-weight: 600;
  flex: 1;
`

const IndentedSection = styled(Section)`
  padding-left: var(--space-lg);
`

const ActionBar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-md);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-border);
`

const SelectionInfo = styled.span`
  color: var(--color-text-secondary);
`

const ButtonGroup = styled.div`
  display: flex;
  gap: var(--space-sm);
`

const EmptyState = styled.div`
  text-align: center;
  padding: var(--space-xl);
  color: var(--color-text-secondary);
`

interface PendingRecipe {
  boxId: BoxId;
  recipeId: RecipeId;
  recipe: RecipeEntry;
}

interface BatchEnrichmentModalProps {
  open: boolean;
  onClose: () => void;
}

function BatchEnrichmentModal({ open, onClose }: BatchEnrichmentModalProps) {
  const { state } = useContext(Context);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState(false);

  // Find all recipes with pending enrichments
  const pendingRecipes = useMemo(() => {
    const results: PendingRecipe[] = [];
    for (const [boxId, box] of state.boxes) {
      for (const [recipeId, recipe] of box.recipes) {
        if (recipe.pendingEnrichment) {
          results.push({ boxId, recipeId, recipe });
        }
      }
    }
    return results;
  }, [state.boxes]);

  const getKey = (boxId: string, recipeId: string) => `${boxId}:${recipeId}`;

  const toggleSelection = (boxId: string, recipeId: string) => {
    const key = getKey(boxId, recipeId);
    const newSelected = new Set(selectedIds);
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    setSelectedIds(newSelected);
  };

  const selectAll = () => {
    setSelectedIds(new Set(pendingRecipes.map(p => getKey(p.boxId, p.recipeId))));
  };

  const selectNone = () => {
    setSelectedIds(new Set());
  };

  const handleAcceptSelected = async () => {
    setProcessing(true);
    try {
      for (const { boxId, recipeId, recipe } of pendingRecipes) {
        if (selectedIds.has(getKey(boxId, recipeId)) && recipe.pendingEnrichment) {
          await applyEnrichment(boxId, recipeId, recipe.pendingEnrichment);
        }
      }
      setSelectedIds(new Set());
    } finally {
      setProcessing(false);
    }
  };

  const handleRejectSelected = async () => {
    setProcessing(true);
    try {
      for (const { boxId, recipeId } of pendingRecipes) {
        if (selectedIds.has(getKey(boxId, recipeId))) {
          await rejectEnrichment(boxId, recipeId);
        }
      }
      setSelectedIds(new Set());
    } finally {
      setProcessing(false);
    }
  };

  const handleAcceptAll = async () => {
    setProcessing(true);
    try {
      for (const { boxId, recipeId, recipe } of pendingRecipes) {
        if (recipe.pendingEnrichment) {
          await applyEnrichment(boxId, recipeId, recipe.pendingEnrichment);
        }
      }
    } finally {
      setProcessing(false);
    }
  };

  const handleRejectAll = async () => {
    setProcessing(true);
    try {
      for (const { boxId, recipeId } of pendingRecipes) {
        await rejectEnrichment(boxId, recipeId);
      }
    } finally {
      setProcessing(false);
    }
  };

  return (
    <Modal
      title={
        <span>
          <RobotOutlined style={{ marginRight: 8, color: '#9370db' }} />
          Review AI Suggestions ({pendingRecipes.length})
        </span>
      }
      open={open}
      onCancel={onClose}
      width={700}
      footer={null}
    >
      {pendingRecipes.length === 0 ? (
        <EmptyState>
          <RobotOutlined style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }} />
          <p>No pending AI suggestions to review.</p>
        </EmptyState>
      ) : (
        <>
          <ActionBar>
            <SelectionInfo>
              {selectedIds.size} of {pendingRecipes.length} selected
              {' · '}
              <a onClick={selectAll}>Select all</a>
              {' · '}
              <a onClick={selectNone}>Select none</a>
            </SelectionInfo>
            <ButtonGroup>
              <Button
                icon={<CheckOutlined />}
                onClick={handleAcceptSelected}
                disabled={selectedIds.size === 0 || processing}
                loading={processing}
              >
                Accept Selected
              </Button>
              <Button
                icon={<CloseOutlined />}
                onClick={handleRejectSelected}
                disabled={selectedIds.size === 0 || processing}
                loading={processing}
              >
                Dismiss Selected
              </Button>
            </ButtonGroup>
          </ActionBar>

          <EnrichmentList>
            {pendingRecipes.map(({ boxId, recipeId, recipe }) => {
              const key = getKey(boxId, recipeId);
              const enrichment = recipe.pendingEnrichment!;
              const currentDescription = recipe.getData().description;
              const hasNewDescription = enrichment.description && enrichment.description !== currentDescription;

              return (
                <EnrichmentItem key={key} $selected={selectedIds.has(key)}>
                  <ItemHeader>
                    <Checkbox
                      checked={selectedIds.has(key)}
                      onChange={() => toggleSelection(boxId, recipeId)}
                    />
                    <RecipeName>{recipe.getName()}</RecipeName>
                  </ItemHeader>

                  {hasNewDescription && (
                    <IndentedSection>
                      <SectionLabel>Suggested description:</SectionLabel>
                      <SuggestedDescription>"{enrichment.description}"</SuggestedDescription>
                    </IndentedSection>
                  )}

                  <IndentedSection>
                    <SectionLabel>Suggested tags:</SectionLabel>
                    <TagsContainer>
                      {enrichment.suggestedTags.map((tag, idx) => (
                        <Tag key={idx} color="purple">{tag}</Tag>
                      ))}
                    </TagsContainer>
                  </IndentedSection>

                  <IndentedSection>
                    <Reasoning><strong>Why:</strong> {enrichment.reasoning}</Reasoning>
                  </IndentedSection>
                </EnrichmentItem>
              );
            })}
          </EnrichmentList>

          <ActionBar style={{ marginTop: 'var(--space-md)', marginBottom: 0, paddingBottom: 0, borderBottom: 'none', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-md)' }}>
            <span />
            <ButtonGroup>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={handleAcceptAll}
                disabled={processing}
                loading={processing}
                style={{ background: '#52c41a', borderColor: '#52c41a' }}
              >
                Accept All
              </Button>
              <Button
                danger
                icon={<CloseOutlined />}
                onClick={handleRejectAll}
                disabled={processing}
                loading={processing}
              >
                Dismiss All
              </Button>
            </ButtonGroup>
          </ActionBar>
        </>
      )}
    </Modal>
  );
}

export default BatchEnrichmentModal;
