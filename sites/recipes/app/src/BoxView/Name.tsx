import React, { useContext, useState } from 'react';
import styled from 'styled-components';
import { Context } from '../context';
import { Title } from '../StyledComponents';
import { getAppUserFromState, getBoxFromState } from '../state';
import { BoxProps } from './BoxView';
import { Input } from 'antd';

const EditableTitle = styled(Input)`
  font-size: 2em;
  font-weight: bold;
  font-family: sans-serif;
  padding-left: 5px;
  margin-bottom: 0px;
  height: fit-content;
  width: fit-content;
  display: inline;
  outline: none;
`

function BoxName(props: BoxProps) {
  const { boxId } = props;
  const [editable, setEditablePrimitive] = useState(false);
  const { state, dispatch } = useContext(Context);
  const box = getBoxFromState(state, boxId)

  const setEditable = (value: boolean) => {
    const user = getAppUserFromState(state)
    if (state.writeable && user && box && box.owners.includes(user.id)) {
      setEditablePrimitive(value)
    }
  }

  const rd = box ? (box.changed ? box.changed : box.data) : { name: "", url: "" }
  const name = rd.name as string
  const [value, setValue] = useState<string>(name);
  if (box === undefined) { return null }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e !== undefined) {
      setValue(e.target.value);
    }
  }

  function confirmChange() {
    if (name !== value) {
      dispatch({ type: "SET_BOX_NAME", boxId, payload: value });
    }
    setEditable(false);
  }
  if (editable) {
    return (
      <EditableTitle type="text"
        defaultValue={name}
        autoFocus
        onChange={(e) => handleChange(e)}
        onKeyUp={(e) => { if (e.code === "Escape" || e.code === "Enter") { confirmChange() } }}
        onBlur={() => confirmChange()} />
    )
  } else {
    return (
      <Title onDoubleClick={() => setEditable(true)}>
        {name}
      </Title>
    )
  }
}

export default BoxName;