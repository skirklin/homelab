import { ShareAltOutlined } from '@ant-design/icons';
import { Menu } from 'antd';
import { useContext, useState } from 'react';
import { Context } from '../context';
import { ActionButton } from '../StyledComponents';
import { AddOwnerModal } from '../Modals/AddOwnerModal';


interface AddOwnerProps {
  element: "button" | "menu"
  disabled?: boolean
  handleOk: (newOwnerEmail: string) => void
}

function AddOwnerButton(props: AddOwnerProps) {
  const { state } = useContext(Context)
  const [isVisible, setIsVisible] = useState(false)
  const { writeable } = state;

  const { handleOk, element, disabled } = props;

  let elt;
  switch (element) {
    case "button":
      elt = <ActionButton title="Add new owner" onClick={() => setIsVisible(true)} disabled={disabled} icon={<ShareAltOutlined />} >Add owner</ActionButton>
      break;
    case "menu":
      elt = <Menu.Item key="addOwner" onClick={() => setIsVisible(true)} title="Add new owner" disabled={disabled} icon={<ShareAltOutlined />} >Add owner</Menu.Item>
      break;
  }


  if (writeable) {
    return (
      <>
        {elt}
        <AddOwnerModal isVisible={isVisible} setIsVisible={setIsVisible} handleOk={handleOk} />
      </>
    )
  } else {
    return null
  }
}

export default AddOwnerButton;