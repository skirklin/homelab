import { EditOutlined } from '@ant-design/icons';
import { Button, Modal, Spin, Space, Typography, Input, Alert } from 'antd';
import { useContext, useState } from 'react';
import { modifyRecipe } from '../backend';
import { Context } from '../context';
import { useRecipesBackend } from '../backend-provider';
import { pendingChangesToBackend } from '../adapters';
import { getRecipeFromState } from '../state';
import { type BoxId, type PendingChanges, type RecipeId } from '../types';
import { RecipeDiffView } from './RecipeDiffView';

const { Text } = Typography;
const { TextArea } = Input;

interface ModifyRecipeModalProps {
  boxId: BoxId;
  recipeId: RecipeId;
  isVisible: boolean;
  setIsVisible: (isVisible: boolean) => void;
}

function ModifyRecipeModal(props: ModifyRecipeModalProps) {
  const { isVisible, setIsVisible, boxId, recipeId } = props;
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<PendingChanges | null>(null);
  const { state } = useContext(Context);
  const recipesBackend = useRecipesBackend();

  const recipe = getRecipeFromState(state, boxId, recipeId);
  const recipeData = recipe?.getData();

  async function handleGenerate() {
    if (!feedback.trim()) return;

    setLoading(true);
    setError(null);
    setChanges(null);

    try {
      const response = await modifyRecipe({ boxId, recipeId, feedback });
      setChanges(JSON.parse(response.data.modificationJson) as PendingChanges);
    } catch (err) {
      console.error('Error generating modifications:', err);
      setError('Failed to generate modifications. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleApply() {
    if (!changes) return;

    try {
      await recipesBackend.applyChanges(recipeId, pendingChangesToBackend(changes));
      handleClose();
    } catch (err) {
      console.error('Error applying modifications:', err);
      setError('Failed to apply modifications. Please try again.');
    }
  }

  async function handleReject() {
    try {
      await recipesBackend.rejectChanges(recipeId, 'modification');
      setChanges(null);
    } catch (err) {
      console.error('Error rejecting modifications:', err);
    }
  }

  function handleClose() {
    setIsVisible(false);
    setFeedback('');
    setChanges(null);
    setError(null);
  }

  if (!recipe || !recipeData) {
    return null;
  }

  // Extract original recipe data for diff
  const originalIngredients = Array.isArray(recipeData.recipeIngredient)
    ? recipeData.recipeIngredient as string[]
    : [];
  const originalInstructions = Array.isArray(recipeData.recipeInstructions)
    ? (recipeData.recipeInstructions as Array<{ text?: string } | string>).map(i =>
        typeof i === 'string' ? i : i.text || ''
      )
    : [];

  return (
    <Modal
      title={
        <span>
          <EditOutlined style={{ marginRight: 8, color: '#9370db' }} />
          Modify Recipe with AI
        </span>
      }
      open={isVisible}
      onCancel={handleClose}
      footer={null}
      width={700}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {!changes && (
          <>
            <div>
              <Text strong>What would you like to change?</Text>
              <div style={{ marginTop: 8 }}>
                <TextArea
                  autoFocus
                  rows={3}
                  placeholder="E.g., Make it vegetarian, reduce the salt, double the recipe, make it spicier..."
                  value={feedback}
                  onChange={e => setFeedback(e.target.value)}
                  onPressEnter={e => {
                    if (e.ctrlKey || e.metaKey) {
                      handleGenerate();
                    }
                  }}
                />
              </div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Describe the changes you want. AI will suggest modifications to ingredients and instructions.
              </Text>
            </div>

            <Spin spinning={loading} tip="Analyzing recipe...">
              <Button
                type="primary"
                onClick={handleGenerate}
                disabled={!feedback.trim() || loading}
                icon={<EditOutlined />}
                style={{ background: '#9370db', borderColor: '#9370db' }}
              >
                Generate Modifications
              </Button>
            </Spin>
          </>
        )}

        {error && (
          <Alert type="error" message={error} showIcon />
        )}

        {changes && (
          <>
            <Text strong>Proposed Changes:</Text>
            <RecipeDiffView
              original={{
                ingredients: originalIngredients,
                instructions: originalInstructions,
              }}
              modified={{
                ingredients: changes.data?.recipeIngredient || originalIngredients,
                instructions: (changes.data?.recipeInstructions || []).map(i =>
                  typeof i === 'string' ? i : i.text || ''
                ),
              }}
              reasoning={changes.reasoning}
            />

            <Space>
              <Button
                type="primary"
                onClick={handleApply}
                style={{ background: '#52c41a', borderColor: '#52c41a' }}
              >
                Apply Changes
              </Button>
              <Button onClick={handleReject}>
                Discard
              </Button>
              <Button
                onClick={() => {
                  setChanges(null);
                  setFeedback('');
                }}
              >
                Try Different Feedback
              </Button>
            </Space>
          </>
        )}
      </Space>
    </Modal>
  );
}

export default ModifyRecipeModal;
