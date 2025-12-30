import { RobotOutlined } from '@ant-design/icons';
import { Button, Modal, Spin, Space, Typography, Input, Alert } from 'antd';
import { useContext, useState } from 'react';
import { Recipe } from 'schema-dts';
import styled from 'styled-components';
import { generateRecipe } from '../backend';
import { Context } from '../context';
import { addRecipe } from '../firestore';
import { RecipeEntry } from '../storage';
import { getAppUserFromState } from '../state';
import { BoxId, Visibility } from '../types';

const { Text } = Typography;
const { TextArea } = Input;

const PreviewCard = styled.div`
  background: var(--color-bg-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-top: var(--space-md);
`

const RecipeName = styled.h3`
  margin: 0 0 var(--space-sm) 0;
  color: var(--color-text);
`

const RecipeDescription = styled.p`
  font-style: italic;
  color: var(--color-text-secondary);
  margin-bottom: var(--space-md);
`

const SectionTitle = styled.div`
  font-weight: 600;
  margin-top: var(--space-sm);
  margin-bottom: var(--space-xs);
  color: var(--color-text);
`

const IngredientList = styled.ul`
  margin: 0;
  padding-left: var(--space-lg);
`

const InstructionList = styled.ol`
  margin: 0;
  padding-left: var(--space-lg);
`

interface GenerateRecipeModalProps {
  boxId: BoxId | undefined
  isVisible: boolean
  setIsVisible: (isVisible: boolean) => void
}

function GenerateRecipeModal(props: GenerateRecipeModalProps) {
  const { isVisible, setIsVisible, boxId } = props;
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedRecipe, setGeneratedRecipe] = useState<Recipe | null>(null);
  const { dispatch, state } = useContext(Context);

  const user = getAppUserFromState(state);

  async function handleGenerate() {
    if (!prompt.trim()) return;

    setLoading(true);
    setError(null);
    setGeneratedRecipe(null);

    try {
      const response = await generateRecipe({ prompt });
      const recipe = JSON.parse(response.data.recipeJson) as Recipe;
      setGeneratedRecipe(recipe);
    } catch (err) {
      console.error('Error generating recipe:', err);
      setError('Failed to generate recipe. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleAddToBox() {
    if (!generatedRecipe || !boxId || !user) return;

    const now = new Date();
    const recipeEntry = new RecipeEntry(
      generatedRecipe,
      [user.id],
      Visibility.private,
      user.id,
      '',
      now,
      now,
      user.id
    );

    addRecipe(boxId, recipeEntry);
    handleClose();
  }

  function handleClose() {
    setIsVisible(false);
    setPrompt('');
    setGeneratedRecipe(null);
    setError(null);
  }

  if (boxId === undefined) {
    return null;
  }

  const ingredients = generatedRecipe?.recipeIngredient;
  const instructions = generatedRecipe?.recipeInstructions;

  return (
    <Modal
      title={
        <span>
          <RobotOutlined style={{ marginRight: 8 }} />
          Generate Recipe with AI
        </span>
      }
      open={isVisible}
      onCancel={handleClose}
      footer={null}
      width={600}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text strong>Describe the recipe you want:</Text>
          <div style={{ marginTop: 8 }}>
            <TextArea
              autoFocus
              rows={3}
              placeholder="E.g., A healthy chicken stir-fry with vegetables, or a chocolate cake that's easy to make..."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onPressEnter={e => {
                if (e.ctrlKey || e.metaKey) {
                  handleGenerate();
                }
              }}
            />
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Tip: Be specific about ingredients, cuisine style, dietary needs, or cooking method.
          </Text>
        </div>

        <Spin spinning={loading} tip="Generating recipe...">
          <Button
            type="primary"
            onClick={handleGenerate}
            disabled={!prompt.trim() || loading}
            icon={<RobotOutlined />}
          >
            Generate Recipe
          </Button>
        </Spin>

        {error && (
          <Alert type="error" message={error} showIcon />
        )}

        {generatedRecipe && (
          <PreviewCard>
            <RecipeName>{String(generatedRecipe.name || 'Untitled Recipe')}</RecipeName>
            {generatedRecipe.description && (
              <RecipeDescription>{String(generatedRecipe.description)}</RecipeDescription>
            )}

            {ingredients && Array.isArray(ingredients) && ingredients.length > 0 && (
              <>
                <SectionTitle>Ingredients</SectionTitle>
                <IngredientList>
                  {ingredients.map((ing, i) => (
                    <li key={i}>{String(ing)}</li>
                  ))}
                </IngredientList>
              </>
            )}

            {instructions && Array.isArray(instructions) && instructions.length > 0 && (
              <>
                <SectionTitle>Instructions</SectionTitle>
                <InstructionList>
                  {instructions.map((inst, i) => (
                    <li key={i}>
                      {typeof inst === 'string' ? inst : (inst as { text?: string }).text || ''}
                    </li>
                  ))}
                </InstructionList>
              </>
            )}

            <div style={{ marginTop: 16 }}>
              <Button type="primary" onClick={handleAddToBox}>
                Add to Recipe Box
              </Button>
              <Button style={{ marginLeft: 8 }} onClick={() => setGeneratedRecipe(null)}>
                Generate Another
              </Button>
            </div>
          </PreviewCard>
        )}
      </Space>
    </Modal>
  );
}

export default GenerateRecipeModal;
