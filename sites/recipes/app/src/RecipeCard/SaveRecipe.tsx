import styled from 'styled-components';
import { SaveOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { useContext } from 'react';
import { useNavigate } from 'react-router-dom';

import { Context } from '../context';
import { addRecipe, saveRecipe } from '../firestore';
import { getAppUserFromState, getBoxFromState, getRecipeFromState } from '../state';
import { canUpdateRecipe } from '../utils';
import { RecipeCardProps } from './RecipeCard';
import _ from 'lodash';

const StyledButton = styled(Button)`
  background-color: lightgreen;
`

function SaveButton(props: RecipeCardProps) {
  const { state, dispatch } = useContext(Context);
  const { recipeId, boxId } = props;
  const recipe = getRecipeFromState(state, boxId, recipeId)
  const box = getBoxFromState(state, boxId)
  const user = getAppUserFromState(state)
  const navigate = useNavigate()

  if (recipe === undefined || box === undefined) {
    return null
  }

  const save = async () => {
    let docRef;
    if (recipe.changed === undefined || user === undefined ) {
      return
    }
    const newRecipe = _.cloneDeep(recipe)
    newRecipe.data = recipe.changed
    newRecipe.changed = undefined
    newRecipe.editing = false
    newRecipe.lastUpdatedBy = user.id
    newRecipe.updated = new Date()
    if (recipeId.startsWith("uniqueId=")) {
      docRef = await addRecipe(boxId, newRecipe)
      newRecipe.created = newRecipe.updated
      dispatch({type: "REMOVE_RECIPE", recipeId, boxId}) // removes the local-only version of the recipe
      navigate(`/boxes/${boxId}/recipes/${docRef.id}`)
    } else {
      docRef = await saveRecipe(boxId, recipeId, newRecipe)
    }
  }

  let writeable = false;
  if (state.writeable &&  canUpdateRecipe(recipe, box, user)) {
    writeable = true;
  }

  if (recipe.changed) {
    return <StyledButton icon={<SaveOutlined />} disabled={!writeable} onClick={save}>Save</StyledButton>
  } else {
    return null
  }
}

export default SaveButton;