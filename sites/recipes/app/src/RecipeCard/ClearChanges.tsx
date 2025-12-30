import { useContext } from 'react';
import styled from 'styled-components';

import { Button } from 'antd';
import { Context } from '../context';
import { RecipeCardProps } from './RecipeCard';
import { getRecipeFromState } from '../state';

const StyledButton = styled(Button)`
`

function ClearButton(props: RecipeCardProps) {
  const { state, dispatch } = useContext(Context);
  const { recipeId, boxId } = props;
  const recipe = getRecipeFromState(state, boxId, recipeId)
  if (!recipe) return null
  function clear() {
    dispatch({ type: "RESET_RECIPE", recipeId, boxId })
  }

  if (recipe.changed) {
    return <StyledButton onClick={clear}>Clear changes</StyledButton>
  } else {
    return null
  }
}

export default ClearButton;