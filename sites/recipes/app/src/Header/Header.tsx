import styled from 'styled-components';
import { Button, Tooltip } from 'antd';
import { getAuth, signOut } from 'firebase/auth';
import { InboxOutlined, LogoutOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { AppHeader } from '@kirkl/shared';

import './Header.css';
import Breadcrumbs from './Breadcrumbs';
import CookingMode from './CookingMode';

const UserName = styled.span`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin-right: var(--space-sm);
`;

interface HeaderProps {
  /** When true, hides account actions (handled by parent shell) */
  embedded?: boolean;
}

function Header({ embedded = false }: HeaderProps) {
  const navigate = useNavigate();
  const user = getAuth().currentUser;

  // When embedded, no dropdown menu - parent Shell handles account actions
  // When standalone, dropdown has Manage Boxes (for mobile) and Sign Out
  const menuItems = embedded ? [] : [
    { key: "boxes", icon: <InboxOutlined />, label: "Manage Boxes", onClick: () => navigate("boxes") },
    { type: "divider" as const },
    { key: "signout", icon: <LogoutOutlined />, label: "Sign Out", onClick: () => signOut(getAuth()) },
  ];

  // Desktop: always show CookingMode and Manage Boxes inline
  const desktopActions = (
    <>
      {!embedded && user && <UserName>{user.displayName}</UserName>}
      <CookingMode />
      <Tooltip title="Manage boxes">
        <Button type="text" onClick={() => navigate('boxes')} icon={<InboxOutlined />} />
      </Tooltip>
    </>
  );

  // Mobile: CookingMode inline, other actions in menu (or inline if embedded)
  const mobileActions = (
    <>
      <CookingMode />
      {embedded && (
        <Button type="text" size="small" onClick={() => navigate('boxes')} icon={<InboxOutlined />} />
      )}
    </>
  );

  return (
    <AppHeader
      title={<Breadcrumbs />}
      menuItems={menuItems}
      desktopActions={desktopActions}
      mobileActions={mobileActions}
    />
  );
}

export default Header;
