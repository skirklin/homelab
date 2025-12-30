import React, { useContext, useState } from 'react';
import styled from 'styled-components';
import { Recipe } from 'schema-dts';
import { instructionsToStr, strToInstructions, decodeStr } from '../converters';
import { getRecipeFromState } from '../state';
import { Context } from '../context';
import { getEditableSetter, RecipeCardProps } from './RecipeCard';
import { StyledTextArea } from '../StyledComponents';

const InstructionsSection = styled.div``

const SectionTitle = styled.h3`
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-primary);
  margin: 0 0 var(--space-md) 0;
`

const InstructionsList = styled.ol`
  margin: 0;
  padding-left: var(--space-lg);
`

const RecipeStep = styled.li`
  padding: var(--space-sm) 0;
  line-height: 1.6;
  font-size: var(--font-size-base);

  &::marker {
    color: var(--color-primary);
    font-weight: 600;
  }
`

const Placeholder = styled.span`
  color: var(--color-text-muted);
  font-style: italic;
`


function InstructionList(props: RecipeCardProps) {
  const [editable, setEditablePrimitive] = useState(false);
  const { recipeId, boxId } = props;
  const { state, dispatch } = useContext(Context);
  const recipe = getRecipeFromState(state, boxId, recipeId)
  if (recipe === undefined) {
    return null
  }

  function formatInstructionList(instructions: Recipe["recipeInstructions"]) {
    let listElts: React.ReactNode[];
    if (typeof instructions === "string") {
      listElts = [<RecipeStep key={0}>{decodeStr(instructions)}</RecipeStep>]
    } else {
      const instructionArray = Array.isArray(instructions) ? instructions : [];
      listElts = instructionArray.map((ri: any, id) => <RecipeStep key={id}>{decodeStr(String(ri.text ?? ''))}</RecipeStep>);
    }
    if (listElts.length > 0) {
      return (
        <InstructionsList>
          {listElts}
        </InstructionsList>
      )
    } else {
      return <Placeholder>Add instructions?</Placeholder>
    }
  }

  if (recipe === undefined) { return null }
  const setEditable = getEditableSetter(state, recipeId, boxId, setEditablePrimitive)

  const instructions = recipe.changed ? recipe.changed.recipeInstructions : recipe.data.recipeInstructions;

  const handleChange = (value: string) => {
    if (instructionsToStr(instructions) !== value) {
      dispatch({ type: "SET_INSTRUCTIONS", boxId, recipeId, payload: strToInstructions(value) });
    }
    setEditable(false)
  }

  if (editable || recipe.editing) {
    return (
      <InstructionsSection>
        <SectionTitle>Instructions</SectionTitle>
        <StyledTextArea
          defaultValue={instructionsToStr(instructions)}
          autoFocus
          autoSize
          placeholder='Add instructions?'
          onKeyUp={(e) => { if (e.code === "Escape") { handleChange(e.currentTarget.value) } }}
          onBlur={e => handleChange(e.target.value)}
        />
      </InstructionsSection>
    )
  } else {
    return (
      <InstructionsSection onDoubleClick={() => setEditable(true)}>
        <SectionTitle>Instructions</SectionTitle>
        {formatInstructionList(instructions)}
      </InstructionsSection>
    )
  }
}

export default InstructionList;