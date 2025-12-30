import { useState } from "react";
import { RobotOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import { useBoxAction } from "../hooks/useBoxAction";
import GenerateRecipeModal from "../Modals/GenerateRecipeModal";
import { ActionButton } from "../StyledComponents";
import { BoxId } from "../types";

interface GenerateProps {
    boxId?: string
    disabled: boolean
}

export default function GenerateButton(props: GenerateProps) {
    const { boxId, disabled } = props;
    const { executeWithBox, BoxPickerModal } = useBoxAction(boxId);
    const [isGenerateVisible, setIsGenerateVisible] = useState(false);
    const [targetBoxId, setTargetBoxId] = useState<BoxId | undefined>();

    const handleClick = () => {
        executeWithBox((selectedBoxId) => {
            setTargetBoxId(selectedBoxId);
            setIsGenerateVisible(true);
        });
    };

    return (<>
        <Tooltip title="Generate recipe with AI">
            <ActionButton
                onClick={handleClick}
                disabled={disabled}
                icon={<RobotOutlined />}
            >
                Generate
            </ActionButton>
        </Tooltip>
        {BoxPickerModal}
        <GenerateRecipeModal
            boxId={targetBoxId}
            isVisible={isGenerateVisible}
            setIsVisible={setIsGenerateVisible}
        />
    </>)
}
