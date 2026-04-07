import { useContext } from 'react';
import { Context } from '../context';
import { subscribeToBox, unsubscribeFromBox } from '../pocketbase';
import { getAppUserFromState, getBoxFromState } from '../state';
import { ActionButton } from '../StyledComponents';
import type { BoxId } from '../types';
import { useAuth } from '@kirkl/shared';

interface DeleteProps {
  boxId: BoxId
}

function SubscribeButton(props: DeleteProps) {
  const { state } = useContext(Context)
  const { user: authUser } = useAuth();
  const { writeable } = state;

  const { boxId } = props;
  const box = getBoxFromState(state, boxId)

  const user = getAppUserFromState(state, authUser?.uid)

  if (box === undefined || user === undefined) {
    return null
  }

  if (!user.boxes.includes(boxId)) {
    return <ActionButton
      onClick={() => subscribeToBox(user, boxId)}
      disabled={!writeable}
    >Add to collection</ActionButton>
  } else {
    return <ActionButton
      onClick={() => unsubscribeFromBox(user, boxId)}
      disabled={!writeable}
    >Remove from collection</ActionButton>
  }
}

export default SubscribeButton;