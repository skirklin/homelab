import { CheckOutlined, CloseOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Tag } from 'antd';
import { useContext } from 'react';
import styled from 'styled-components';
import { Context } from '../context';
import { applyEnrichment, rejectEnrichment } from '../firestore';
import { getRecipeFromState } from '../state';
import type { RecipeCardProps } from './RecipeCard';
import { Section, SectionLabel, SuggestedDescription, TagsContainer, Reasoning } from '../Modals/EnrichmentStyles';

const EnrichmentBanner = styled.div`
  background: linear-gradient(135deg, var(--color-bg-muted) 0%, rgba(147, 112, 219, 0.1) 100%);
  border: 1px solid var(--color-border);
  border-left: 4px solid #9370db;
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-md);
`

const BannerHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
  font-weight: 600;
  color: #9370db;
`

const EnrichmentSection = styled(Section)`
  margin-bottom: var(--space-sm);
`

const StepIngredientsPreview = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`

const StepPreviewItem = styled.div`
  margin: var(--space-xs) 0;
  padding-left: var(--space-sm);
  border-left: 2px solid var(--color-border);
`

const StepNumber = styled.span`
  font-weight: 600;
  color: var(--color-primary);
`

const ButtonRow = styled.div`
  display: flex;
  gap: var(--space-sm);
  margin-top: var(--space-md);
`

function EnrichmentReview(props: RecipeCardProps) {
  const { recipeId, boxId } = props;
  const { state } = useContext(Context);

  const recipe = getRecipeFromState(state, boxId, recipeId);
  if (!recipe?.pendingEnrichment) {
    return null;
  }

  const enrichment = recipe.pendingEnrichment;
  const currentDescription = recipe.getData().description;
  const hasNewDescription = enrichment.description && enrichment.description !== currentDescription;

  async function handleAccept() {
    await applyEnrichment(boxId, recipeId, enrichment);
  }

  async function handleReject() {
    await rejectEnrichment(boxId, recipeId);
  }

  return (
    <EnrichmentBanner>
      <BannerHeader>
        <RobotOutlined />
        AI Suggestions Available
      </BannerHeader>

      {hasNewDescription && (
        <EnrichmentSection>
          <SectionLabel>Suggested description:</SectionLabel>
          <SuggestedDescription>{enrichment.description}</SuggestedDescription>
        </EnrichmentSection>
      )}

      {enrichment.suggestedTags.length > 0 && (
        <EnrichmentSection>
          <SectionLabel>Suggested tags:</SectionLabel>
          <TagsContainer>
            {enrichment.suggestedTags.map((tag, idx) => (
              <Tag key={idx} color="purple">{tag}</Tag>
            ))}
          </TagsContainer>
        </EnrichmentSection>
      )}

      {enrichment.stepIngredients && Object.keys(enrichment.stepIngredients).length > 0 && (
        <EnrichmentSection>
          <SectionLabel>Per-step ingredients (visible in cooking mode):</SectionLabel>
          <StepIngredientsPreview>
            {Object.entries(enrichment.stepIngredients)
              .sort(([a], [b]) => parseInt(a) - parseInt(b))
              .slice(0, 3)  // Show first 3 steps as preview
              .map(([stepIdx, ingredients]) => (
                <StepPreviewItem key={stepIdx}>
                  <StepNumber>Step {parseInt(stepIdx) + 1}:</StepNumber>{' '}
                  {ingredients.join(' · ') || '(no ingredients)'}
                </StepPreviewItem>
              ))}
            {Object.keys(enrichment.stepIngredients).length > 3 && (
              <StepPreviewItem>
                ...and {Object.keys(enrichment.stepIngredients).length - 3} more steps
              </StepPreviewItem>
            )}
          </StepIngredientsPreview>
        </EnrichmentSection>
      )}

      <Reasoning>
        <strong>Why: </strong>{enrichment.reasoning}
      </Reasoning>

      <ButtonRow>
        <Button
          type="primary"
          icon={<CheckOutlined />}
          onClick={handleAccept}
          style={{ background: '#52c41a', borderColor: '#52c41a' }}
        >
          Accept
        </Button>
        <Button
          icon={<CloseOutlined />}
          onClick={handleReject}
        >
          Dismiss
        </Button>
      </ButtonRow>
    </EnrichmentBanner>
  );
}

export default EnrichmentReview;
