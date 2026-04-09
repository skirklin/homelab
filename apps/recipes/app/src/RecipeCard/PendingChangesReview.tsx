import { CheckOutlined, CloseOutlined, EditOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Tag } from 'antd';
import { useContext } from 'react';
import styled from 'styled-components';
import { Context } from '../context';
import { useRecipesBackend } from '@kirkl/shared';
import { pendingChangesToBackend } from '../adapters';
import { getRecipeFromState } from '../state';
import type { RecipeCardProps } from './RecipeCard';
import { RecipeDiffView } from '../Modals/RecipeDiffView';

const ChangesBanner = styled.div`
  background: linear-gradient(135deg, var(--color-bg-muted) 0%, rgba(147, 112, 219, 0.1) 100%);
  border: 1px solid var(--color-border);
  border-left: 4px solid #9370db;
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-md);
`;

const BannerHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
  font-weight: 600;
  color: #9370db;
`;

const Section = styled.div`
  margin-bottom: var(--space-sm);
`;

const SectionLabel = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-xs);
`;

const SuggestedDescription = styled.div`
  font-style: italic;
  color: var(--color-text);
`;

const TagsContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
`;

const StepIngredientsPreview = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const StepPreviewItem = styled.div`
  margin: var(--space-xs) 0;
  padding-left: var(--space-sm);
  border-left: 2px solid var(--color-border);
`;

const StepNumber = styled.span`
  font-weight: 600;
  color: var(--color-primary);
`;

const PromptText = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-sm);
  font-style: italic;
`;

const Reasoning = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-top: var(--space-sm);
`;

const ButtonRow = styled.div`
  display: flex;
  gap: var(--space-sm);
  margin-top: var(--space-md);
`;

function PendingChangesReview(props: RecipeCardProps) {
  const { recipeId, boxId } = props;
  const { state } = useContext(Context);
  const recipesBackend = useRecipesBackend();

  const recipe = getRecipeFromState(state, boxId, recipeId);
  if (!recipe?.pendingChanges) {
    return null;
  }

  const changes = recipe.pendingChanges;
  const recipeData = recipe.getData();
  const currentDescription = typeof recipeData.description === 'string' ? recipeData.description : undefined;
  const currentTags = recipeData.recipeCategory;

  // Extract current recipe data for diff comparison
  const currentIngredients = Array.isArray(recipeData.recipeIngredient)
    ? recipeData.recipeIngredient as string[]
    : [];
  const currentInstructions = Array.isArray(recipeData.recipeInstructions)
    ? (recipeData.recipeInstructions as Array<{ text?: string } | string>).map(i =>
        typeof i === 'string' ? i : i.text || ''
      )
    : [];

  // Check what's being changed
  const hasNewDescription = changes.data?.description && changes.data.description !== currentDescription;
  const hasNewTags = changes.data?.recipeCategory && changes.data.recipeCategory.length > 0;
  const hasIngredientChanges = changes.data?.recipeIngredient !== undefined;
  const hasInstructionChanges = changes.data?.recipeInstructions !== undefined;
  const hasStepIngredients = changes.stepIngredients && Object.keys(changes.stepIngredients).length > 0;

  async function handleAccept() {
    const tags = Array.isArray(currentTags) ? currentTags : currentTags ? [currentTags] : [];
    await recipesBackend.applyChanges(recipeId, pendingChangesToBackend(changes), {
      description: currentDescription,
      tags: tags as string[],
    });
  }

  async function handleReject() {
    await recipesBackend.rejectChanges(recipeId, changes.source);
  }

  const isModification = changes.source === 'modification';
  const Icon = isModification ? EditOutlined : RobotOutlined;
  const title = isModification ? 'AI Modifications Available' : 'AI Suggestions Available';

  return (
    <ChangesBanner>
      <BannerHeader>
        <Icon />
        {title}
      </BannerHeader>

      {changes.prompt && (
        <PromptText>
          Based on your feedback: "{changes.prompt}"
        </PromptText>
      )}

      {/* Show diff for ingredient/instruction changes */}
      {(hasIngredientChanges || hasInstructionChanges) && (
        <RecipeDiffView
          original={{
            ingredients: currentIngredients,
            instructions: currentInstructions,
          }}
          modified={{
            ingredients: changes.data?.recipeIngredient || currentIngredients,
            instructions: (changes.data?.recipeInstructions || []).map(i =>
              typeof i === 'string' ? i : i.text || ''
            ),
          }}
          compact
        />
      )}

      {/* Show description suggestion */}
      {hasNewDescription && (
        <Section>
          <SectionLabel>Suggested description:</SectionLabel>
          <SuggestedDescription>{changes.data!.description}</SuggestedDescription>
        </Section>
      )}

      {/* Show tag suggestions */}
      {hasNewTags && (
        <Section>
          <SectionLabel>Suggested tags:</SectionLabel>
          <TagsContainer>
            {changes.data!.recipeCategory!.map((tag, idx) => (
              <Tag key={idx} color="purple">{tag}</Tag>
            ))}
          </TagsContainer>
        </Section>
      )}

      {/* Show step ingredients */}
      {hasStepIngredients && (
        <Section>
          <SectionLabel>Per-step ingredients (visible in cooking mode):</SectionLabel>
          <StepIngredientsPreview>
            {Object.entries(changes.stepIngredients!)
              .sort(([a], [b]) => parseInt(a) - parseInt(b))
              .slice(0, 3)
              .map(([stepIdx, ingredients]) => (
                <StepPreviewItem key={stepIdx}>
                  <StepNumber>Step {parseInt(stepIdx) + 1}:</StepNumber>{' '}
                  {ingredients.join(' · ') || '(no ingredients)'}
                </StepPreviewItem>
              ))}
            {Object.keys(changes.stepIngredients!).length > 3 && (
              <StepPreviewItem>
                ...and {Object.keys(changes.stepIngredients!).length - 3} more steps
              </StepPreviewItem>
            )}
          </StepIngredientsPreview>
        </Section>
      )}

      {changes.reasoning && (
        <Reasoning>
          <strong>Why: </strong>{changes.reasoning}
        </Reasoning>
      )}

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
    </ChangesBanner>
  );
}

export default PendingChangesReview;
