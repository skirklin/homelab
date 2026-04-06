import { BookOutlined, GlobalOutlined, ShareAltOutlined, LinkOutlined } from "@ant-design/icons";
import { Dropdown, message } from "antd";
import { ActionButton } from "../StyledComponents";
import { Visibility } from "../types";
import { useState, useContext } from "react";
import { Context } from "../context";
import { AddOwnerModal } from "../Modals/AddOwnerModal";
import type { MenuProps } from "antd";

interface VisibilityProps {
    element: "menu" | "button"
    disabled?: boolean
    value: Visibility
    boxId?: string
    recipeId?: string
    handleChange: (e: { key: string }) => void
    handleAddOwner: (newOwnerEmail: string) => void
}

export default function VisibilityControl(props: VisibilityProps) {
    const { element, value, handleChange, disabled, handleAddOwner, boxId, recipeId } = props;
    const { state } = useContext(Context);
    const [isAddOwnerVisible, setIsAddOwnerVisible] = useState(false);

    const handleCopyRecipeLink = () => {
        if (boxId && recipeId) {
            const recipeLink = `${window.location.origin}/recipe/${boxId}/${recipeId}`;
            navigator.clipboard.writeText(recipeLink);
            message.success("Recipe link copied!");
        }
    };

    const handleCopyJoinLink = () => {
        if (boxId) {
            const joinLink = `${window.location.origin}/join/${boxId}`;
            navigator.clipboard.writeText(joinLink);
            message.success("Join link copied!");
        }
    };

    let icon;
    switch (value) {
        case Visibility.public:
            icon = <GlobalOutlined />;
            break;
        default:
            icon = <BookOutlined />;
            break;
    }

    const menuItems: MenuProps['items'] = [
        value === Visibility.public
            ? {
                key: Visibility.private,
                icon: <BookOutlined />,
                label: 'Make private',
                onClick: () => handleChange({ key: Visibility.private }),
            }
            : {
                key: Visibility.public,
                icon: <GlobalOutlined />,
                label: 'Make visible',
                onClick: () => handleChange({ key: Visibility.public }),
            },
    ];

    // Only add these options if writeable
    if (state.writeable) {
        if (boxId && recipeId) {
            // Recipe: show both public link and join link
            menuItems.push({
                key: 'copyRecipeLink',
                icon: <LinkOutlined />,
                label: 'Copy recipe link',
                onClick: handleCopyRecipeLink,
            });
            menuItems.push({
                key: 'copyJoinLink',
                icon: <ShareAltOutlined />,
                label: 'Copy join link',
                onClick: handleCopyJoinLink,
            });
        } else if (boxId) {
            // Box: just show join link
            menuItems.push({
                key: 'copyJoinLink',
                icon: <LinkOutlined />,
                label: 'Copy share link',
                onClick: handleCopyJoinLink,
            });
        }
        menuItems.push({
            key: 'addOwner',
            icon: <ShareAltOutlined />,
            label: 'Add owner by email',
            onClick: () => setIsAddOwnerVisible(true),
        });
    }

    let elt;
    switch (element) {
        case "button":
            elt = <ActionButton disabled={disabled} title="Change sharing level" icon={icon}>Sharing</ActionButton>
            break;

        case "menu":
            elt = <span title="Change sharing level">{icon} Sharing</span>
            break;
    }

    return (
        <>
            <Dropdown disabled={disabled} menu={{ items: menuItems }}>
                {elt}
            </Dropdown>
            <AddOwnerModal
                isVisible={isAddOwnerVisible}
                setIsVisible={setIsAddOwnerVisible}
                handleOk={handleAddOwner}
            />
        </>
    )
}
