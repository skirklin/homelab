import { Input, Modal } from 'antd';

import { useState } from 'react';
import { BoxId } from '../types';


interface PickBoxModalProps {
  handleOk: (value: string) => void
  isVisible: boolean
  setIsVisible: (visible: boolean) => void
  disableBoxes?: BoxId[]
}

export function AddOwnerModal(props: PickBoxModalProps) {
  const { isVisible, setIsVisible, handleOk } = props;
  const [value, setValue] = useState("")

  return (
    <Modal destroyOnHidden={true} open={isVisible} onOk={() => { handleOk(value); setIsVisible(false) }} onCancel={() => setIsVisible(false)}>
      <Input type="text" onChange={e => setValue(e.target.value)} value={value} />
    </Modal >
  );
}