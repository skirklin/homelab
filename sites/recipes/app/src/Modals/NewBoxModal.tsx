import { Input, Modal } from "antd"
import { useContext, useState } from "react"
import { addBox } from '../firestore';
import { getAppUserFromState } from '../state';
import { Context } from "../context";
import { DocumentReference } from "firebase/firestore";
import { BoxEntry } from "../storage";

interface NewBoxModalProps {
  isVisible: boolean
  setIsVisible: (visible: boolean) => void
  afterNewBox?: (box: DocumentReference<BoxEntry>) => void
}

function NewBoxModal(props: NewBoxModalProps) {
  const { isVisible, setIsVisible, afterNewBox } = props;
  const { dispatch, state } = useContext(Context)
  const [newBoxName, setNewBoxName] = useState<string>();
  const [confirmLoading, setConfirmLoading] = useState(false);
  const user = getAppUserFromState(state)

  if (user === undefined) { 
    return null
  }

  const handleOk = async () => {
    setConfirmLoading(true);

    if (newBoxName === undefined) {
      return
    }
    const newBoxRef = await addBox(user, newBoxName)
    if (afterNewBox !== undefined && newBoxRef !== undefined) {
      afterNewBox(newBoxRef)
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