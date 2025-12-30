import { useState } from "react";
import { useBoxAction } from "../hooks/useBoxAction";
import ImportModal from "../Modals/ImportModal";
import { ImportOutlined } from "@ant-design/icons";
import { ActionButton } from "../StyledComponents";
import { BoxId } from "../types";
import { Menu } from "antd";

interface ImportProps {
    boxId?: string
    disabled: boolean
    element: "menu" | "button"
}

export default function ImportButton(props: ImportProps) {
    const { boxId, disabled, element } = props;
    const { executeWithBox, BoxPickerModal } = useBoxAction(boxId);
    const [isImportVisible, setIsImportVisible] = useState(false);
    const [targetBoxId, setTargetBoxId] = useState<BoxId | undefined>();

    const handleClick = () => {
        executeWithBox((selectedBoxId) => {
            setTargetBoxId(selectedBoxId);
            setIsImportVisible(true);
        });
    };

    let elt;
    switch (element) {
        case "button":
            elt = <ActionButton onClick={handleClick} title="Import recipe by URL" icon={<ImportOutlined />} disabled={disabled} >
                Import
            </ActionButton>
            break;
        case "menu":
            elt = <Menu.Item key="import" onClick={handleClick} title="Import recipe by URL" icon={<ImportOutlined />} disabled={disabled} >
                Import
            </Menu.Item>
            break;
    }

    return (<>
        {elt}
        {BoxPickerModal}
        <ImportModal boxId={targetBoxId} setIsVisible={setIsImportVisible} isVisible={isImportVisible} />
    </>)
}
