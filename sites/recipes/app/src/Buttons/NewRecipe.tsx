import { PlusOutlined } from "@ant-design/icons";
import { useContext } from "react";
import { useNavigate } from "react-router-dom";
import { Context } from "../context";
import { useBoxAction } from "../hooks/useBoxAction";
import { getAppUserFromState } from "../state";
import { createNewRecipe, getUniqueId } from "../utils";
import { PrimaryButton } from "../StyledComponents";
import { BoxId } from "../types";
import { Menu } from "antd";


interface NewProps {
    boxId?: string
    element: "menu" | "button"
    disabled: boolean
}

export default function NewButton(props: NewProps) {
    const { boxId, disabled, element } = props;
    const { state, dispatch } = useContext(Context)
    const navigate = useNavigate()
    const { executeWithBox, BoxPickerModal } = useBoxAction(boxId);
    const user = getAppUserFromState(state)

    const addNewRecipe = (targetBoxId: BoxId) => {
        if (user === undefined) {
            return
        }
        const recipe = createNewRecipe(user);
        const recipeId = `uniqueId=${getUniqueId(recipe)}`
        dispatch({ type: "ADD_RECIPE", payload: recipe, boxId: targetBoxId, recipeId })
        navigate(`/boxes/${targetBoxId}/recipes/${recipeId}`)
    }

    const handleClick = () => {
        executeWithBox(addNewRecipe);
    };

    let elt;
    switch (element) {
        case "button":
            elt = <PrimaryButton title="Create new recipe" disabled={disabled} onClick={handleClick} icon={<PlusOutlined />}>
                New
            </PrimaryButton>
            break;
        case "menu":
            elt = <Menu.Item key="newRecipe" title="Create new recipe" disabled={disabled} onClick={handleClick} icon={<PlusOutlined />} >
                New
            </Menu.Item>
            break;
    }

    return (<>
        {elt}
        {BoxPickerModal}
    </>)
}
