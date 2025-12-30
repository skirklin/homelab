import React, { useContext, useState } from 'react';
import styled from 'styled-components';
import { LinkOutlined } from '@ant-design/icons';
import { Context } from '../context';
import { Title } from '../StyledComponents';
import { getRecipeFromState } from '../state';
import { getEditableSetter, RecipeCardProps } from './RecipeCard';
import { Input } from 'antd';

const EditableTitle = styled(Input)`
  font-size: 2em;
  font-weight: bold;
  font-family: sans-serif;
  display: inline;
  outline: none;
  padding-left: 5px;
  margin-bottom: 0px;
  height: fit-content;
  width: fit-content;
`

function RecipeName(props: RecipeCardProps) {
  const { recipeId, boxId } = props;
  const { state, dispatch } = useContext(Context);
  const recipe = getRecipeFromState(state, boxId, recipeId)
  const [editable, setEditablePrimitive] = useState(false);

  const name = recipe ? recipe.getName() : undefined
  const [value, setValue] = useState(name);
  const setEditable = getEditableSetter(state, recipeId, boxId, setEditablePrimitive)
  if (recipe === undefined) {
    return null
  }

  const url = recipe.getData().url
  if (recipe === undefined) { return null }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e !== undefined) {
      setValue(e.target.value);
    }
  }

  function confirmChange() {
    if (name !== value) {
      dispatch({ type: "SET_RECIPE_NAME", recipeId, boxId, payload: value });
    }
    setEditable(false);
  }
  let link = null;
  if (url) {
    link = <a href={url.toString()} target="_blank" rel="noreferrer"><LinkOutlined /></a>
  }
  if (editable || recipe.editing) {
    return (
      <EditableTitle type="text"
        defaultValue={name}
        autoFocus
        onChange={(e) => handleChange(e)}
        onKeyUp={(e) => { if (e.code === "Escape" || e.code === "Enter") { confirmChange() } }}
        onBlur={() => confirmChange()}
      />
    )
  } else {
    return (
      <Title onDoubleClick={() => setEditable(true)}>
        {name} {link}
      </Title>
    )
  }
}

export default RecipeName;