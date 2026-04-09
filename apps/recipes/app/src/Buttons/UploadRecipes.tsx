import { UploadOutlined } from "@ant-design/icons";
import { useContext } from "react";
import { useBoxAction } from "../hooks/useBoxAction";
import { useRecipesBackend } from "@kirkl/shared";
import { recipeDataToBackend } from "../adapters";
import { getAppUserFromState } from "../state";
import { ActionButton } from "../StyledComponents";
import type { BoxId } from "../types";
import { Menu } from "antd";
import { Context } from "../context";
import { useAuth } from '@kirkl/shared';


interface UploadProps {
    boxId?: string
    disabled: boolean
    element: "button" | "menu"
}

export default function UploadButton(props: UploadProps) {
    const { boxId, disabled, element } = props;
    const { executeWithBox, BoxPickerModal } = useBoxAction(boxId);
    const { state } = useContext(Context)
    const { user: authUser } = useAuth();
    const recipesBackend = useRecipesBackend();
    const user = getAppUserFromState(state, authUser?.uid)

    if (!import.meta.env.DEV) {
        return null
    }

    const upload = async (targetBoxId: BoxId) => {
        if (user === undefined) {
            return
        }
        const fileHandles = await (window as unknown as { showOpenFilePicker: (opts: { multiple: boolean }) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
            multiple: true,
        });
        for (const fh of fileHandles) {
            const f = await fh.getFile();
            const text = await f.text();
            const jsonobj = JSON.parse(text);
            await recipesBackend.addRecipe(targetBoxId, jsonobj, user.id);
        }
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
