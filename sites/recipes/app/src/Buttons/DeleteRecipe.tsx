import { DeleteOutlined } from '@ant-design/icons';
import { Menu, Popconfirm } from 'antd';
import { useContext } from 'react';
import { Context } from '../context';
import { useNavigate } from 'react-router-dom';
import { deleteRecipe } from '../firestore';
import { getAppUserFromState, getBoxFromState, getRecipeFromState } from '../state';
import { ActionButton } from '../StyledComponents';
import { BoxId, RecipeId } from '../types';


interface DeleteProps {
  recipeId: RecipeId
  boxId: BoxId
  element: "button" | "menu"
}

function DeleteButton(props: DeleteProps) {
  const { state, dispatch } = useContext(Context)
  const { writeable } = state;
  const box = getBoxFromState(state, props.boxId)
  const recipe = getRecipeFromState(state, props.boxId, props.recipeId)

  const navigate = useNavigate()

  const { recipeId, boxId, element } = props;
  const user = getAppUserFromState(state)

  if (recipe === undefined || box === undefined || user === undefined) {
    return null
  }
  if (!(recipe.owners.includes(user.id) || box.owners.includes(user.id))) {
    return null
  }


  async function del() {
    deleteRecipe(state, boxId, recipeId, dispatch).then(
      () => navigate(`/boxes/${boxId}`)
    )
  }

  let elt;
  switch (element) {
    case "button":
      elt = <ActionButton title="Delete this recipe?" icon={<DeleteOutlined />} >Delete</ActionButton>
      break;
    case "menu":
      elt = <Menu.Item key="deleteRecipe" title="Delete this recipe?" icon={<DeleteOutlined />} >Delete</Menu.Item>
      break;
  }


  if (writeable) {
    return (
      <Popconfirm
        title="Are you sure you want to delete this recipe?"
        onConfirm={del}
        okText="Yes"
        cancelText="No"
      >{elt}</Popconfirm>
    )
  } else {
    return null
  }
}

export default DeleteButton;