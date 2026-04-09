import { DeleteOutlined } from '@ant-design/icons';
import { Menu, Popconfirm } from 'antd';
import { useContext } from 'react';
import { Context } from '../context';
import { useNavigate } from 'react-router-dom';
import { useRecipesBackend } from '@kirkl/shared';
import { getAppUserFromState, getBoxFromState } from '../state';
import { ActionButton } from '../StyledComponents';
import type { BoxId } from '../types';
import { useAuth } from '@kirkl/shared';


interface DeleteProps {
  boxId: BoxId
  element: "button" | "menu"
}

function DeleteButton(props: DeleteProps) {
  const { state, dispatch } = useContext(Context)
  const { user: authUser } = useAuth();
  const recipes = useRecipesBackend();
  const { writeable } = state;
  const navigate = useNavigate()

  const { boxId, element } = props;
  const box = getBoxFromState(state, boxId);
  const user = getAppUserFromState(state, authUser?.uid);

  if (box === undefined || user === undefined || !box.owners.includes(user.id)) {
    return null
  }

  async function del() {
    dispatch({ type: "REMOVE_BOX", boxId });
    await recipes.deleteBox(boxId);
    navigate(".")
  }

  let elt;
  switch (element) {
    case "button":
      elt = <ActionButton title="Delete this box?" icon={<DeleteOutlined />} >Delete</ActionButton>
      break;
    case "menu":
      elt = <Menu.Item key="deleteBox" title="Delete this box?" icon={<DeleteOutlined />} >Delete</Menu.Item>
      break;
  }

  if (writeable) {
    return (
      <Popconfirm
        title="Are you sure you want to delete this box?"
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