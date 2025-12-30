import { useContext, useState } from 'react';
import { commentToStr, strToComment } from '../converters';
import { getRecipeFromState } from '../state';
import { Context } from '../context';
import { getEditableSetter, RecipeCardProps } from './RecipeCard';
import styled from 'styled-components';
import { StyledTextArea } from '../StyledComponents';

const NotesSection = styled.div`
  margin-top: var(--space-md);
`

const SectionTitle = styled.h3`
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-sm) 0;
`

const NotesContent = styled.div`
  background-color: var(--color-bg-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  font-size: var(--font-size-base);
  line-height: 1.6;
  white-space: pre-wrap;
`

const Placeholder = styled.span`
  color: var(--color-text-muted);
  font-style: italic;
`


function Notes(props: RecipeCardProps) {
  const [editable, setEditablePrimitive] = useState(false);
  const { recipeId, boxId } = props;
  const { state, dispatch } = useContext(Context);
  const recipe = getRecipeFromState(state, boxId, recipeId)
  if (recipe === undefined) {
    return null
  }

  const setEditable = getEditableSetter(state, recipeId, boxId, setEditablePrimitive)

  const rd = recipe.changed ? recipe.changed : recipe.data
  const comment = commentToStr(rd.comment)

  const handleChange = (value: string) => {
    if (comment !== value) {
      dispatch({ type: "SET_COMMENT", recipeId, boxId, payload: strToComment(value) });
    }
    setEditable(false)
  }

  if (editable || recipe.editing) {
    return (
      <NotesSection>
        <SectionTitle>Notes</SectionTitle>
        <StyledTextArea
          autoSize
          autoFocus
          defaultValue={comment}
          placeholder='Add a note?'
          onKeyUp={(e) => { if (e.code === "Escape") { handleChange(e.currentTarget.value) } }}
          onBlur={e => handleChange(e.target.value)}
        />
      </NotesSection>
    )
  } else {
    return (
      <NotesSection>
        <SectionTitle>Notes</SectionTitle>
        <NotesContent onDoubleClick={() => setEditable(true)}>
          {comment || <Placeholder>Add a note?</Placeholder>}
        </NotesContent>
      </NotesSection>
    )
  }
}

export default Notes;