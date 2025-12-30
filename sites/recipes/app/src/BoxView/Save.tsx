import styled from 'styled-components';
import { SaveOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { doc, setDoc } from 'firebase/firestore';
import { useContext } from 'react';

import { db } from '../backend';
import { Context } from '../context';
import { getAppUserFromState, getBoxFromState } from '../state';
import _ from 'lodash';
import { boxConverter } from '../storage';
import { BoxProps } from './BoxView';

const StyledButton = styled(Button)`
  background-color: lightgreen;
`

function SaveButton(props: BoxProps) {
  const { state } = useContext(Context);
  const { boxId } = props;
  const box = getBoxFromState(state, boxId)
  const user = getAppUserFromState(state)

  if (box === undefined) {
    return null
  }

  const save = async () => {
    if (box.changed === undefined) {
      return
    }
    const newBox = _.cloneDeep(box)
    newBox.data = box.changed
    newBox.changed = undefined
    const docRef = doc(db, "boxes", boxId).withConverter(boxConverter)
    await setDoc(docRef, newBox)
  }

  let writeable = false;
  if (state.writeable && user && box.owners.includes(user.id) && box !== undefined) {
    writeable = true;
  }

  if (box.changed) {
    return <StyledButton icon={<SaveOutlined />} disabled={!writeable} onClick={save}>Save</StyledButton>
  } else {
    return null
  }
}

export default SaveButton;