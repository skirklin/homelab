import { PlusOutlined } from '@ant-design/icons';
import { Modal, Select } from 'antd';
import { DocumentReference } from 'firebase/firestore';

import { useContext, useEffect, useState } from 'react';
import NewBoxModal from './NewBoxModal';
import { Context } from '../context';
import { BoxEntry } from '../storage';
import { BoxId } from '../types';

const ADD_NEW_VALUE = '__add_new__';

type OptionsType = { value: string, label: React.ReactNode }

interface SelectBoxProps {
  setBoxId: (value: string) => void
  boxId: BoxId
  disableBoxes?: BoxId[]
  onAddNew: () => void
}

function SelectBox(props: SelectBoxProps) {
  const { setBoxId, boxId, disableBoxes, onAddNew } = props;
  const { state } = useContext(Context)

  const boxOptions: OptionsType[] = [];
  for (const [key, box] of state.boxes.entries()) {
    if (disableBoxes && disableBoxes.includes(key)) {
      continue
    } else {
      boxOptions.push(
        { label: box.data.name, value: key }
      )
    }
  }

  // Add the "Add new..." option at the end
  boxOptions.push({
    value: ADD_NEW_VALUE,
    label: <span><PlusOutlined style={{ marginRight: 8 }} />Add new box...</span>
  });

  const defaultBoxId = boxOptions.length > 1 ? boxOptions[0].value : ""
  useEffect(() => {
    if (boxId === "" && defaultBoxId !== "") {
      setBoxId(defaultBoxId)
    }
  }, [state, defaultBoxId, setBoxId, boxId]
  )

  const handleChange = (value: string) => {
    if (value === ADD_NEW_VALUE) {
      onAddNew();
    } else {
      setBoxId(value);
    }
  };

  return (
    <Select
      style={{ width: "100%" }}
      autoFocus
      value={boxId || undefined}
      onChange={handleChange}
      placeholder="Select a box..."
      options={boxOptions}
    />
  )
}

interface PickBoxModalProps {
  handleOk: (boxId: BoxId) => void
  isVisible: boolean
  setIsVisible: (visible: boolean) => void
  disableBoxes?: BoxId[]
}

export function PickBoxModal(props: PickBoxModalProps) {
  const { handleOk, isVisible, setIsVisible, disableBoxes } = props;
  const [boxId, setBoxId] = useState("")
  const [showNewBoxModal, setShowNewBoxModal] = useState(false)

  const afterNewBox = (boxRef: DocumentReference<BoxEntry>) => {
    setBoxId(boxRef.id)
    setShowNewBoxModal(false)
  }

  return (
    <>
      <Modal
        title="Choose a box"
        destroyOnHidden={true}
        open={isVisible}
        onOk={() => { handleOk(boxId) }}
        onCancel={() => setIsVisible(false)}
        okText="Select"
        okButtonProps={{ disabled: !boxId }}
      >
        <SelectBox
          setBoxId={setBoxId}
          boxId={boxId}
          disableBoxes={disableBoxes}
          onAddNew={() => setShowNewBoxModal(true)}
        />
      </Modal>
      <NewBoxModal
        isVisible={showNewBoxModal}
        setIsVisible={setShowNewBoxModal}
        afterNewBox={afterNewBox}
      />
    </>
  );
}