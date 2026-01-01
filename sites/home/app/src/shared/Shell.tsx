import { useEffect } from "react";
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
import { getBackend } from "@kirkl/shared";

const LAST_PATH_KEY = "home:lastPath";

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

export function Shell() {
  const location = useLocation();
  const navigate = useNavigate();

  // Save current path when navigating to a sub-app
  useEffect(() => {
    const subApps = ["/life", "/groceries", "/recipes", "/upkeep"];
    const isSubApp = subApps.some(app => location.pathname.startsWith(app));
    if (isSubApp) {
      localStorage.setItem(LAST_PATH_KEY, location.pathname);
    }
  }, [location.pathname]);

  const isActive = (path: string) => location.pathname.startsWith(path);

  const handleSignOut = async () => {
    const { auth } = getBackend();
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
          <NavButton
            icon={<ShoppingCartOutlined />}
            $active={isActive("/recipes")}
            onClick={() => navigate("/recipes")}
          >
            Recipes
          </NavButton>
          <NavButton
            icon={<ShoppingCartOutlined />}
            $active={isActive("/groceries")}
            onClick={() => navigate("/groceries")}
          >
            Groceries
          </NavButton>
          <NavButton
            icon={<CheckSquareOutlined />}
            $active={isActive("/upkeep")}
            onClick={() => navigate("/upkeep")}
          >
            Upkeep
          </NavButton>
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
