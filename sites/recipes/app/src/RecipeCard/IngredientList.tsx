import { useState, useContext } from 'react';
import styled from 'styled-components';
import { PlusOutlined } from '@ant-design/icons';
import type { Recipe } from 'schema-dts';
import { ingredientsToStr, strToIngredients, decodeStr } from '../converters';
import { getAppUserFromState, getBoxFromState, getRecipeFromState } from '../state';
import { canUpdateRecipe } from '../utils';
import { Context } from '../context';
import type { RecipeCardProps } from './RecipeCard';
import { StyledTextArea } from '../StyledComponents';
import { useAuth } from '@kirkl/shared';
import { useGroceriesIntegration } from '../GroceriesIntegrationContext';
import { AddToGroceriesModal } from '../Modals/AddToGroceriesModal';

const IngredientsSection = styled.div`
  position: relative;
  background-color: var(--color-bg-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-md);
`

const SectionTitle = styled.h3`
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-primary);
  margin: 0 0 var(--space-md) 0;
`

const IngredientsList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`

const Ingredient = styled.li`
  padding: var(--space-xs) 0;
  border-bottom: 1px solid var(--color-border-light);
  font-size: var(--font-size-base);

  &:last-child {
    border-bottom: none;
  }
`

const Placeholder = styled.span`
  color: var(--color-text-muted);
  font-style: italic;
`

const AddToGroceriesButton = styled.button`
  position: absolute;
  bottom: var(--space-sm);
  right: var(--space-sm);
  background: var(--color-primary);
  border: none;
  border-radius: 50%;
  width: 28px;
  height: 28px;
  cursor: pointer;
  color: white;
  opacity: 0.7;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s;

  &:hover {
    opacity: 1;
  }
`

function IngredientList(props: RecipeCardProps) {
  const [editable, setEditablePrimitive] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedIngredient, setSelectedIngredient] = useState("");
  const { recipeId, boxId } = props;
  const { state, dispatch } = useContext(Context);
  const { user: authUser } = useAuth();
  const groceriesIntegration = useGroceriesIntegration();
  const recipe = getRecipeFromState(state, boxId, recipeId)
  const box = getBoxFromState(state, boxId)

  if (recipe === undefined || box === undefined) {
    return null
  }

  const hasGroceriesIntegration = groceriesIntegration && Object.keys(groceriesIntegration.userSlugs).length > 0;

  const handleAddToGroceries = () => {
    // Pre-fill with first ingredient if available
    const ingredientArray = Array.isArray(ingredients) ? ingredients : [];
    const firstIngredient = ingredientArray.length > 0 ? decodeStr(String(ingredientArray[0])) : "";
    setSelectedIngredient(firstIngredient);
    setShowAddModal(true);
  };

  const setEditable = (value: boolean) => {
    const user = getAppUserFromState(state, authUser?.uid)
    if (state.writeable && canUpdateRecipe(recipe, box, user)) {
      setEditablePrimitive(value)
    }
  }

  const ingredients = recipe.changed ? recipe.changed.recipeIngredient : recipe.data.recipeIngredient || [];
  const handleChange = (value: string) => {
    if (ingredientsToStr(ingredients) !== value) {
      dispatch({ type: "SET_INGREDIENTS", recipeId, boxId, payload: strToIngredients(value) });
    }
    setEditable(false)
  }

  function formatIngredientList(ingredients: Recipe["recipeIngredient"]) {
    const ingredientArray = Array.isArray(ingredients) ? ingredients : [];
    const listElts = ingredientArray.map((ri, id) => <Ingredient key={id}>{decodeStr(String(ri))}</Ingredient>);
    return (
      <IngredientsList>
        {listElts.length > 0 ? listElts : <Placeholder>Add ingredients?</Placeholder>}
      </IngredientsList>
    )
  }

  if (editable || recipe.editing) {
    return (
      <IngredientsSection>
        <SectionTitle>Ingredients</SectionTitle>
        <StyledTextArea
          defaultValue={ingredientsToStr(ingredients)}
          autoFocus
          autoSize
          placeholder='Add ingredients?'
          onKeyUp={(e) => { if (e.code === "Escape") { handleChange(e.currentTarget.value) } }}
          onBlur={(e) => handleChange(e.target.value)}
        />
      </IngredientsSection>
    )
  } else {
    return (
      <>
        <IngredientsSection onDoubleClick={() => setEditable(true)}>
          <SectionTitle>Ingredients</SectionTitle>
          {formatIngredientList(ingredients)}
          {hasGroceriesIntegration && (
            <AddToGroceriesButton
              onClick={(e) => {
                e.stopPropagation();
                handleAddToGroceries();
              }}
              title="Add to grocery list"
            >
              <PlusOutlined />
            </AddToGroceriesButton>
          )}
        </IngredientsSection>
        {groceriesIntegration && (
          <AddToGroceriesModal
            isVisible={showAddModal}
            setIsVisible={setShowAddModal}
            ingredient={selectedIngredient}
            integration={groceriesIntegration}
          />
        )}
      </>
    )
  }
}

export default IngredientList
