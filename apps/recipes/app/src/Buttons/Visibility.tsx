import { BookOutlined, GlobalOutlined, ShareAltOutlined, LinkOutlined, TeamOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";
import { ActionButton } from "../StyledComponents";
import { Visibility } from "../types";
import { useState, useContext } from "react";
import { useFeedback } from "@kirkl/shared";
import { Context } from "../context";
import { createShareInvite } from "../backend";
import { OwnersModal } from "../Modals/OwnersModal";
import type { MenuProps } from "antd";

interface VisibilityProps {
    element: "menu" | "button"
    disabled?: boolean
    value: Visibility
    boxId?: string
    recipeId?: string
    owners?: string[]
    subscribers?: string[]
    handleChange: (e: { key: string }) => void
}

export default function VisibilityControl(props: VisibilityProps) {
    const { message } = useFeedback();
    const { element, value, handleChange, disabled, boxId, recipeId, owners, subscribers } = props;
    const { state } = useContext(Context);
    const [isOwnersVisible, setIsOwnersVisible] = useState(false);

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

    const handleCreateInvite = async () => {
        try {
            const targetType = recipeId ? "recipe" : "box";
            const targetId = recipeId || boxId;
            if (!targetId) return;

            const result = await createShareInvite({ targetType, targetId });
            await navigator.clipboard.writeText(result.data.url);
            message.success("Invite link copied to clipboard!");
        } catch (err) {
            message.error("Failed to create invite link");
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
            key: 'createInvite',
            icon: <ShareAltOutlined />,
            label: 'Create invite link',
            onClick: handleCreateInvite,
        });
        if (owners && owners.length > 0) {
            const subscriberOnlyCount = (subscribers || []).filter(id => !owners.includes(id)).length;
            const totalPeople = owners.length + subscriberOnlyCount;
            menuItems.push({
                key: 'viewOwners',
                icon: <TeamOutlined />,
                label: `View people (${totalPeople})`,
                onClick: () => setIsOwnersVisible(true),
            });
        }
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
            <OwnersModal
                isVisible={isOwnersVisible}
                setIsVisible={setIsOwnersVisible}
                ownerIds={owners || []}
                subscriberIds={subscribers || []}
            />
        </>
    )
}
