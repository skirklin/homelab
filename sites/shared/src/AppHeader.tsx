import type { ReactNode } from "react";
import { Button, Dropdown } from "antd";
import type { MenuProps } from "antd";
import { ArrowLeftOutlined, SettingOutlined, MenuOutlined } from "@ant-design/icons";
import styled from "styled-components";

const HeaderContainer = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  gap: var(--space-sm);
  min-height: 52px;
`;

const LeftSection = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
  flex: 1;
`;

const Title = styled.div`
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
`;

const RightSection = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-shrink: 0;
`;

const DesktopOnly = styled.div`
  display: none;
  align-items: center;
  gap: var(--space-xs);

  @media (min-width: 480px) {
    display: flex;
  }
`;

const MobileOnly = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);

  @media (min-width: 480px) {
    display: none;
  }
`;

const BackButton = styled(Button)`
  flex-shrink: 0;
`;

export interface AppHeaderProps {
  /** Page/list title - can be a string or custom ReactNode (e.g., breadcrumbs) */
  title: ReactNode;
  /** Called when back button is clicked. If not provided, back button is hidden. */
  onBack?: () => void;
  /** Primary action button (e.g., "Add Task", "Done Shopping") */
  primaryAction?: {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
    /** Show only when this is true */
    visible?: boolean;
  };
  /** Menu items for the settings dropdown */
  menuItems?: MenuProps["items"];
  /** Additional actions to show on desktop (between primary action and menu) */
  desktopActions?: ReactNode;
  /** Additional content to show in mobile menu area */
  mobileActions?: ReactNode;
}

/**
 * Consistent app header used across all apps.
 *
 * Features:
 * - Optional back button
 * - Title with ellipsis overflow
 * - Optional primary action button
 * - Settings dropdown menu
 * - Responsive: collapses to hamburger menu on mobile
 */
export function AppHeader({
  title,
  onBack,
  primaryAction,
  menuItems = [],
  desktopActions,
  mobileActions,
}: AppHeaderProps) {
  const showPrimaryAction = primaryAction && (primaryAction.visible ?? true);

  return (
    <HeaderContainer>
      <LeftSection>
        {onBack && (
          <BackButton
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={onBack}
          />
        )}
        <Title>{title}</Title>
      </LeftSection>

      <RightSection>
        {/* Desktop: show all actions inline */}
        <DesktopOnly>
          {desktopActions}
          {showPrimaryAction && (
            <Button
              type="primary"
              icon={primaryAction.icon}
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </Button>
          )}
          {menuItems.length > 0 && (
            <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
              <Button type="text" icon={<SettingOutlined />} />
            </Dropdown>
          )}
        </DesktopOnly>

        {/* Mobile: show primary action + hamburger menu */}
        <MobileOnly>
          {mobileActions}
          {showPrimaryAction && (
            <Button
              type="primary"
              icon={primaryAction.icon}
              onClick={primaryAction.onClick}
              size="small"
            >
              {primaryAction.label}
            </Button>
          )}
          {menuItems.length > 0 && (
            <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomRight">
              <Button icon={<MenuOutlined />} size="small" />
            </Dropdown>
          )}
        </MobileOnly>
      </RightSection>
    </HeaderContainer>
  );
}
