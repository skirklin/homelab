import { Switch } from "antd";
import { useContext } from "react";
import { Context } from "../context";

export default function Settings() {
  const { state, dispatch } = useContext(Context);
  const { writeable } = state;

  return <div>
    <h1>Settings</h1>
    <div>
      <Switch
        className={writeable ? 'readonly-switch-writeable' : 'readonly-switch-readonly'}
        onChange={e => dispatch({ type: "SET_READONLY", payload: e })}
        checkedChildren="Edit-mode"
        unCheckedChildren="Read-only"
      />
    </div>
  </div>
}