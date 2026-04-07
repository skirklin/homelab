import { PlusOutlined } from "@ant-design/icons";
import { PrimaryButton } from "../StyledComponents";
import NewBoxModal from "../Modals/NewBoxModal";
import { useState } from "react";
interface NewProps {
    disabled: boolean
    afterNewBox?: (box: { id: string }) => void
}

export default function NewButton(props: NewProps) {
    const { disabled, afterNewBox } = props;
    const [isModalVisible, setIsModalVisible] = useState(false)

    return (<>
        <PrimaryButton title="Create new box." disabled={disabled} onClick={() => setIsModalVisible(true)} icon={<PlusOutlined />} >New</PrimaryButton>
        <NewBoxModal isVisible={isModalVisible} setIsVisible={setIsModalVisible} afterNewBox={afterNewBox} />
    </>)

}