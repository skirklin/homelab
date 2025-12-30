import styled from 'styled-components';

import { Button, Tooltip } from 'antd';

import { getAuth, signOut } from 'firebase/auth';
import { InboxOutlined, LogoutOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import './Header.css';
import CookingMode from './CookingMode';

const MenuArea = styled.nav`
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
`

const UserName = styled.span`
  color: rgba(255, 255, 255, 0.9);
  font-size: var(--font-size-sm);
  margin-right: var(--space-sm);
`

const IconButton = styled(Button)`
  background-color: transparent;
  color: white;
  border: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  transition: all 0.2s ease;

  &:hover {
    color: white;
    background-color: rgba(255, 255, 255, 0.15);
  }
  &:focus {
    color: white;
    background-color: rgba(255, 255, 255, 0.15);
  }
`


function Menu() {
  const navigate = useNavigate()
  const user = getAuth().currentUser
  if (user === null) {
    return null
  }

  return (
    <MenuArea>
      <UserName>{user.displayName}</UserName>
      <CookingMode />
      <Tooltip title="Manage boxes">
        <IconButton onClick={() => navigate('/boxes')} icon={<InboxOutlined />} />
      </Tooltip>
      <Tooltip title="Sign out">
        <IconButton onClick={() => signOut(getAuth())} icon={<LogoutOutlined />} />
      </Tooltip>
    </MenuArea>
  );
}

export default Menu;
