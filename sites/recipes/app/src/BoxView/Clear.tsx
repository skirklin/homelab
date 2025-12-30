import { useContext } from 'react';
import styled from 'styled-components';

import { Button } from 'antd';
import { Context } from '../context';
import { getBoxFromState } from '../state';
import { BoxProps } from './BoxView';

const StyledButton = styled(Button)`
`

function ClearButton(props: BoxProps) {
  const { state, dispatch } = useContext(Context);
  const { boxId } = props;
  const box = getBoxFromState(state, boxId)
  if (!box) return null
  function clear() {
    dispatch({ type: "RESET_BOX", boxId })
  }

  if (box.changed) {
    return <StyledButton onClick={clear}>Clear changes</StyledButton>
  } else {
    return null
  }
}

export default ClearButton;