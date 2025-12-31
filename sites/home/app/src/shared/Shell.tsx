import { Outlet, useLocation, useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Dropdown } from "antd";
import {
  HomeOutlined,
  ExperimentOutlined,
  ShoppingCartOutlined,
  CheckSquareOutlined,
  SettingOutlined,
  LogoutOutlined,
} from "@ant-design/icons";
import { signOut } from "firebase/auth";
import { auth } from "./backend";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-primary);
  color: white;
`;

const Nav = styled.nav`
  display: flex;
  gap: var(--space-xs);
`;

const NavButton = styled(Button)<{ $active?: boolean }>`
  &.ant-btn {
    color: ${props => props.$active ? 'var(--color-primary)' : 'white'};
    background: ${props => props.$active ? 'white' : 'transparent'};
    border: none;

    &:hover {
      color: ${props => props.$active ? 'var(--color-primary)' : 'white'};
      background: ${props => props.$active ? 'white' : 'rgba(255, 255, 255, 0.15)'};
    }

    .anticon {
      color: inherit;
    }
  }
`;

const IconButton = styled(Button)`
  &.ant-btn {
    color: white;
    background: transparent;
    border: none;

    &:hover {
      color: white;
      background: rgba(255, 255, 255, 0.15);
    }

    .anticon {
      color: white;
    }
  }
`;

const Content = styled.main`
  flex: 1;
  background: var(--color-bg-subtle);
`;

const ExternalLinks = styled.div`
  display: flex;
  gap: var(--space-xs);
  margin-left: var(--space-md);
  padding-left: var(--space-md);
  border-left: 1px solid rgba(255, 255, 255, 0.3);
`;

const ExternalLink = styled.a`
  color: white;
  opacity: 0.8;
  text-decoration: none;
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  display: flex;
  align-items: center;
  gap: var(--space-xs);

  &:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.1);
  }

  .anticon {
    color: white;
  }
`;

export function Shell() {
  const location = useLocation();
  const navigate = useNavigate();

  const isActive = (path: string) => location.pathname.startsWith(path);

  const handleSignOut = async () => {
    await signOut(auth);
    navigate("/");
  };

  const menuItems = [
    {
      key: "signout",
      icon: <LogoutOutlined />,
      label: "Sign Out",
      onClick: handleSignOut,
    },
  ];

  return (
    <Container>
      <Header>
        <Nav>
          <NavButton
            icon={<HomeOutlined />}
            $active={location.pathname === "/"}
            onClick={() => navigate("/")}
          >
            Home
          </NavButton>
          <NavButton
            icon={<ExperimentOutlined />}
            $active={isActive("/life")}
            onClick={() => navigate("/life")}
          >
            Life
          </NavButton>
          <ExternalLinks>
            <ExternalLink href="https://recipes.kirkl.in" target="_blank">
              <ShoppingCartOutlined /> Recipes
            </ExternalLink>
            <ExternalLink href="https://groceries.kirkl.in" target="_blank">
              <ShoppingCartOutlined /> Groceries
            </ExternalLink>
            <ExternalLink href="https://upkeep.kirkl.in" target="_blank">
              <CheckSquareOutlined /> Upkeep
            </ExternalLink>
          </ExternalLinks>
        </Nav>
        <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
          <IconButton icon={<SettingOutlined />} />
        </Dropdown>
      </Header>
      <Content>
        <Outlet />
      </Content>
    </Container>
  );
}
