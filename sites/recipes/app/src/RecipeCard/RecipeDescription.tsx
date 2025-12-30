import { useContext, useState } from 'react';
import styled from 'styled-components';
import { Context } from '../context';
import { StyledTextArea } from '../StyledComponents';
import { getRecipeFromState } from '../state';
import { getEditableSetter, RecipeCardProps } from './RecipeCard';


const Description = styled.div`
  font-style: italic;
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  line-height: 1.6;
  margin: var(--space-sm) 0;
  white-space: pre-wrap;
`

const Placeholder = styled.span`
  color: var(--color-text-muted);
`

function RecipeDescription(props: RecipeCardProps) {
  const { recipeId, boxId } = props;
  const [editable, setEditablePrimitive] = useState(false);
  const { state, dispatch } = useContext(Context);

  const recipe = getRecipeFromState(state, boxId, recipeId)
  if (recipe === undefined) { return null }
  const setEditable = getEditableSetter(state, recipeId, boxId, setEditablePrimitive)

  const description = recipe.getDescription()
  function handleChange(value: string) {
    if (value !== description) {
      dispatch({ type: "SET_DESCRIPTION", recipeId, boxId, payload: value });
    }
    setEditable(false);
  }

  let textAreaProps;
  if (description !== undefined) {
    textAreaProps = { defaultValue: description }
  } else {
    textAreaProps = {}
  }

  if (editable || recipe.editing) {
    return (
      <StyledTextArea
        autoSize
        placeholder="Add a description?"
        autoFocus
        onKeyUp={(e) => { if (e.code === "Escape") { handleChange(e.currentTarget.value) } }}
        style={{ fontStyle: "italic" }}
        onBlur={e => handleChange(e.target.value)}
        {...textAreaProps}
      />
    )
  } else {
    return (
      <Description onDoubleClick={() => setEditable(true)}>
        {description || <Placeholder>Add a description?</Placeholder>}
      </Description>
    )
  }
}

export default RecipeDescription;