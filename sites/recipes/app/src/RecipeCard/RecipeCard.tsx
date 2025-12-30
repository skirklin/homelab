import styled from 'styled-components';

import SaveButton from './SaveRecipe';
import ClearButton from './ClearChanges';
import InstructionList from './InstructionList';
import IngredientList from './IngredientList';
import RecipeName from './RecipeName';
import RecipeDescription from './RecipeDescription';
import EnrichmentReview from './EnrichmentReview';
import Notes from './Notes'
import CookingLog from './CookingLog'
import DeleteButton from '../Buttons/DeleteRecipe'
import DownloadButton from '../Buttons/DownloadRecipe';
import VisibilityControl from '../Buttons/Visibility';
import ForkButton from '../Buttons/ForkRecipe';
import { AppState, BoxId, RecipeId, Visibility } from '../types';
import { addCookingLogEntry } from '../firestore';
import { Divider, RecipeActionGroup } from '../StyledComponents';
import ByLine from './Byline';
import Tags from './Tags';
import { Button, Dropdown, Menu, Input, Modal, message } from 'antd';
import { MoreOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useContext, useState } from 'react';
import { Context } from '../context';
import { setRecipeVisibility } from '../firestore';
import { getAppUserFromState, getBoxFromState, getRecipeFromState } from '../state';
import { canUpdateRecipe } from '../utils';
import { addRecipeOwner } from '../backend';
import EditButton from '../Buttons/EditRecipe';

const RecipeContainer = styled.article`
  max-width: 800px;
  margin: 0 auto;
  padding: var(--space-md);
`

const RecipeHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-sm);
`

const RecipeMeta = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-sm) var(--space-lg);
  margin-bottom: var(--space-md);
`

const RecipeBody = styled.div`
  display: grid;
  grid-template-columns: minmax(200px, 1fr) 2fr;
  gap: var(--space-lg);

  @media (max-width: 768px) {
    grid-template-columns: 1fr;
  }
`

const ActionButtonsRow = styled.div`
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
`

export function getEditableSetter(state: AppState, recipeId: RecipeId, boxId: BoxId, setEditable: (value: boolean) => void) {
  return (value: boolean) => {
    const user = getAppUserFromState(state)
    const recipe = getRecipeFromState(state, boxId, recipeId)
    const box = getBoxFromState(state, boxId)
    if (state.writeable && canUpdateRecipe(recipe, box, user)) {
      setEditable(value)
    }
  }
}

export interface RecipeCardProps {
  recipeId: RecipeId
  boxId: BoxId
}

const MadeItButton = styled(Button)`
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
  &:hover:not(:disabled) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
    color: white;
  }
`

function QuickMadeIt(props: RecipeCardProps) {
  const { recipeId, boxId } = props;
  const { state } = useContext(Context);
  const user = getAppUserFromState(state);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);

  if (!user) return null;

  const handleMadeIt = async () => {
    setLoading(true);
    try {
      await addCookingLogEntry(boxId, recipeId, user.id, note.trim() || undefined);
      setNote('');
      setIsModalOpen(false);
      message.success('Added to cooking log!');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <MadeItButton
        icon={<CheckCircleOutlined />}
        onClick={() => setIsModalOpen(true)}
      >
        I made it!
      </MadeItButton>
      <Modal
        title="I made it!"
        open={isModalOpen}
        onCancel={() => setIsModalOpen(false)}
        onOk={handleMadeIt}
        okText="Save"
        confirmLoading={loading}
      >
        <p>Add an optional note about how it went:</p>
        <Input.TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g., Added extra garlic, kids loved it!"
          rows={3}
          autoFocus
        />
      </Modal>
    </>
  );
}

const MenuButton = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--space-sm);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover {
    background-color: var(--color-bg-muted);
    color: var(--color-text);
  }
`

function ActionMenu(props: RecipeCardProps) {
  const { recipeId, boxId } = props;
  const { state } = useContext(Context);
  const recipe = getRecipeFromState(state, boxId, recipeId)
  if (recipe === undefined) {
    return null
  }

  function handleVisiblityChange(e: { key: string | undefined }) {
    setRecipeVisibility(boxId, recipeId, e.key as Visibility)
  }

  function handleAddOwner(newOwnerEmail: string) {
    addRecipeOwner({ boxId, recipeId, newOwnerEmail })
  }

  const menu = (
    <Menu>
      <DeleteButton {...props} element="menu" />
      <DownloadButton {...props} element="menu" />
      <ForkButton {...props} element="menu" />
      <EditButton {...props} element="menu" />
      <VisibilityControl
        {...props}
        handleAddOwner={handleAddOwner}
        handleChange={handleVisiblityChange}
        value={recipe.visibility} element="menu" />
    </Menu>
  )
  return (
    <RecipeActionGroup>
      <QuickMadeIt {...props} />
      <Dropdown overlay={menu} trigger={["click", "hover"]}>
        <MenuButton>
          <MoreOutlined style={{ fontSize: "24px" }} />
        </MenuButton>
      </Dropdown>
    </RecipeActionGroup>
  )
}

function RecipeActions(props: RecipeCardProps) {
  return <ActionMenu {...props} />
}

function RecipeCard(props: RecipeCardProps) {
  return (
    <RecipeContainer>
      <RecipeHeader>
        <RecipeName {...props} />
        <RecipeActions {...props} />
      </RecipeHeader>
      <RecipeMeta>
        <ByLine {...props} />
        <Tags {...props} />
      </RecipeMeta>
      <EnrichmentReview {...props} />
      <RecipeDescription {...props} />
      <Divider />
      <ActionButtonsRow>
        <SaveButton {...props} />
        <ClearButton {...props} />
      </ActionButtonsRow>
      <RecipeBody>
        <IngredientList {...props} />
        <InstructionList {...props} />
      </RecipeBody>
      <Divider />
      <Notes {...props} />
      <Divider />
      <CookingLog {...props} />
    </RecipeContainer>
  );
}

export default RecipeCard;