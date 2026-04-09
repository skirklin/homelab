import { Input, Modal } from "antd"
import { useContext, useState } from "react"
import { useRecipesBackend } from '../backend-provider';
import { getAppUserFromState } from '../state';
import { Context } from "../context";
import { useAuth } from '@kirkl/shared';

interface NewBoxModalProps {
  isVisible: boolean
  setIsVisible: (visible: boolean) => void
  afterNewBox?: (box: { id: string }) => void
}

function NewBoxModal(props: NewBoxModalProps) {
  const { isVisible, setIsVisible, afterNewBox } = props;
  const { state } = useContext(Context)
  const { user: authUser } = useAuth();
  const recipesBackend = useRecipesBackend();
  const [newBoxName, setNewBoxName] = useState<string>();
  const [confirmLoading, setConfirmLoading] = useState(false);
  const user = getAppUserFromState(state, authUser?.uid)

  if (user === undefined) {
    return null
  }

  const handleOk = async () => {
    setConfirmLoading(true);

    if (newBoxName === undefined) {
      return
    }
    const newBoxId = await recipesBackend.createBox(user.id, newBoxName);
    if (afterNewBox !== undefined) {
      afterNewBox({ id: newBoxId })
    }
    setConfirmLoading(false)
    setIsVisible(false)
    setNewBoxName(undefined)
  }

  return (
    <Modal open={isVisible} onOk={handleOk} onCancel={() => setIsVisible(false)} confirmLoading={confirmLoading} >
      <Input
        autoFocus
        title="Name"
        value={newBoxName} onChange={e => setNewBoxName(e.target.value)}
        onKeyUp={(e) => { if (e.code === "Enter") { handleOk() } }}
      />
    </Modal >
  )
}

export default NewBoxModal