import styled from 'styled-components';
import { SaveOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { getBackend } from '@kirkl/shared';
import { useContext } from 'react';

import { Context } from '../context';
import { getAppUserFromState, getBoxFromState } from '../state';
import _ from 'lodash';
import type { BoxProps } from './BoxView';
import { useAuth } from '@kirkl/shared';

const StyledButton = styled(Button)`
  background-color: lightgreen;
`

function SaveButton(props: BoxProps) {
  const { state } = useContext(Context);
  const { user: authUser } = useAuth();
  const { boxId } = props;
  const box = getBoxFromState(state, boxId)
  const user = getAppUserFromState(state, authUser?.uid)

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
    await getBackend().collection("recipe_boxes").update(boxId, {
      name: newBox.data.name,
      description: newBox.data.description || "",
    });
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
