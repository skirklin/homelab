import { EditFilled } from '@ant-design/icons';
import { useContext } from 'react';

import { Context } from '../context';
import { getAppUserFromState, getBoxFromState, getRecipeFromState } from '../state';
import { canUpdateRecipe } from '../utils';
import { ActionButton } from '../StyledComponents';
import { RecipeCardProps } from '../RecipeCard/RecipeCard';
import { Menu } from 'antd';

interface EditProps extends RecipeCardProps {
  element: "menu" | "button"
}

export default function EditButton(props: EditProps) {
  const { boxId, recipeId, element } = props;
  const { state, dispatch } = useContext(Context)
  const recipe = getRecipeFromState(state, boxId, recipeId)
  const box = getBoxFromState(state, boxId)
  const user = getAppUserFromState(state)
  if (recipe === undefined || box === undefined || user === undefined || recipe.editing) {
    return null
  }
  const editable = canUpdateRecipe(recipe, box, user)

  function setEditable() {
    dispatch({ type: "SET_EDITABLE", recipeId, boxId })
  }

  let elt;
  switch (element) {
    case "button":
      switch (editable) {
        case true:
          elt = <ActionButton
            title="Edit recipe."
            disabled={!recipe}
            onClick={setEditable}
            icon={<EditFilled />}
          >
            Edit
          </ActionButton>
          break;
        case false:
          elt = <ActionButton
            title="Edit recipe."
            disabled={true}
            icon={<EditFilled />}
          >
            Read only
          </ActionButton>

          break;
      }
      break;
    case "menu":
      switch (editable) {
        case true:
          elt = <Menu.Item
            key="edit"
            title="Edit recipe."
            disabled={!recipe}
            onClick={setEditable}
            icon={<EditFilled />} >
            Edit
          </Menu.Item>
          break
        case false:
          elt = <Menu.Item
            key="edit"
            title="Edit recipe."
            disabled={true}
            icon={<EditFilled />} >
            Read only
          </Menu.Item>
          break
      }
      break;
  }

  return elt
}