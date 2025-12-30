import { Input } from 'antd';
import { useContext, useState } from 'react';
import styled from 'styled-components';
import { Context } from '../context';
import { authorToStr, strToAuthor } from '../converters';
import { getRecipeFromState } from '../state';
import { getEditableSetter, RecipeCardProps } from './RecipeCard';

const EditableByline = styled(Input)`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  padding: var(--space-xs);
  border-radius: var(--radius-sm);

  &:focus {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(44, 166, 164, 0.1);
  }
`

const StyledByline = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`

const Label = styled.span`
  color: var(--color-text-muted);
`

function Byline(props: RecipeCardProps) {
  const { recipeId, boxId } = props;
  const [editable, setEditablePrimitive] = useState(false);
  const { state, dispatch } = useContext(Context);
  const recipe = getRecipeFromState(state, boxId, recipeId)
  if (recipe === undefined) { return null }

  const setEditable = getEditableSetter(state, recipeId, boxId, setEditablePrimitive)

  const rd = recipe.changed ? recipe.changed : recipe.data
  const byline = authorToStr(rd.author)
  const handleChange = (value: string) => {
    if (byline !== value) {
      dispatch({ type: "SET_AUTHOR", payload: strToAuthor(value), recipeId, boxId });
    }
    setEditable(false);
  }
  const placeholder = <Label>Add author?</Label>;

  if (editable || recipe.editing) {
    return (
      <StyledByline>
        <Label>By</Label>
        <EditableByline type="text"
          defaultValue={byline}
          autoFocus
          placeholder='Add author?'
          onKeyUp={(e) => { if (e.code === "Escape" || e.code === "Enter") { handleChange(e.currentTarget.value) } }}
          onBlur={(e) => handleChange(e.target.value)}
        />
      </StyledByline>
    )
  } else {
    return (
      <StyledByline onDoubleClick={() => setEditable(true)}>
        <Label>By</Label> {byline || placeholder}
      </StyledByline>
    )
  }
}

export default Byline;