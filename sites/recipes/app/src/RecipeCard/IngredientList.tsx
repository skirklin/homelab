import { useState, useContext } from 'react';
import styled from 'styled-components';
import { Recipe } from 'schema-dts';
import { ingredientsToStr, strToIngredients, decodeStr } from '../converters';
import { getAppUserFromState, getBoxFromState, getRecipeFromState } from '../state';
import { canUpdateRecipe } from '../utils';
import { Context } from '../context';
import { RecipeCardProps } from './RecipeCard';
import { StyledTextArea } from '../StyledComponents';

const IngredientsSection = styled.div`
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


function IngredientList(props: RecipeCardProps) {
  const [editable, setEditablePrimitive] = useState(false);
  const { recipeId, boxId } = props;
  const { state, dispatch } = useContext(Context);
  const recipe = getRecipeFromState(state, boxId, recipeId)
  const box = getBoxFromState(state, boxId)

  if (recipe === undefined || box === undefined) {
    return null
  }

  const setEditable = (value: boolean) => {
    const user = getAppUserFromState(state)
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
      <IngredientsSection onDoubleClick={() => setEditable(true)}>
        <SectionTitle>Ingredients</SectionTitle>
        {formatIngredientList(ingredients)}
      </IngredientsSection>
    )
  }
}

export default IngredientList
