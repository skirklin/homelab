import { UploadOutlined } from "@ant-design/icons";
import { useContext } from "react";
import { useBoxAction } from "../hooks/useBoxAction";
import { uploadRecipes } from "../firestore";
import { getAppUserFromState } from "../state";
import { ActionButton } from "../StyledComponents";
import { BoxId } from "../types";
import { Menu } from "antd";
import { Context } from "../context";


interface UploadProps {
    boxId?: string
    disabled: boolean
    element: "button" | "menu"
}

export default function UploadButton(props: UploadProps) {
    const { boxId, disabled, element } = props;
    const { executeWithBox, BoxPickerModal } = useBoxAction(boxId);
    const { state } = useContext(Context)
    const user = getAppUserFromState(state)

    if (process.env.NODE_ENV !== "development") {
        return null
    }

    const upload = (targetBoxId: BoxId) => {
        if (user === undefined) {
            return
        }
        uploadRecipes(targetBoxId, user)
    }

    const handleClick = () => {
        executeWithBox(upload);
    };

    let elt;
    switch (element) {
        case "button":
            elt = <ActionButton onClick={handleClick} title="Upload recipes from computer." icon={<UploadOutlined />} disabled={disabled} >
                Upload
            </ActionButton>
            break;
        case "menu":
            elt = <Menu.Item key="upload" onClick={handleClick} title="Upload recipes from computer." icon={<UploadOutlined />} disabled={disabled} >
                Upload
            </Menu.Item>
            break;
    }

    return (<>
        {elt}
        {BoxPickerModal}
    </>)
}
