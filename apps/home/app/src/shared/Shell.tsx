import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Tooltip } from "antd";
import {
  ExperimentOutlined,
  ShoppingCartOutlined,
  CheckSquareOutlined,
  CompassOutlined,
  LogoutOutlined,
  BookOutlined,
  HistoryOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { getBackend } from "@kirkl/shared";

const LAST_PATH_KEY = "home:lastPath";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const Header = styled.header`
  position: sticky;
  top: 0;
  z-index: 100;
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
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;

  /* Hide scrollbar but keep functionality */
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
`;

const NavButton = styled.button<{ $active?: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  min-width: 44px;
  min-height: 44px;
  flex-shrink: 0;

  color: ${props => props.$active ? '#6366f1' : '#ffffff'};
  background: ${props => props.$active ? '#ffffff' : 'transparent'};

  &:hover, &:focus {
    background: ${props => props.$active ? '#ffffff' : 'rgba(255, 255, 255, 0.15)'};
    outline: none;
  }

  /* On narrow screens, hide text and show only icons */
  @media (max-width: 480px) {
    padding: 8px 12px;

    .nav-label {
      display: none;
    }
  }
`;

const NavIcon = styled.span<{ $active?: boolean }>`
  display: inline-flex;
  font-size: 20px;

  .anticon {
    color: ${props => props.$active ? '#6366f1' : '#ffffff'};
  }

  .anticon svg {
    fill: ${props => props.$active ? '#6366f1' : '#ffffff'};
  }
`;

const HeaderActions = styled.div`
  display: flex;
  gap: 4px;
`;

const IconButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: white;
  cursor: pointer;
  font-size: 18px;

  &:hover {
    background: rgba(255, 255, 255, 0.15);
  }
`;

const Content = styled.main`
  flex: 1;
  background: var(--color-bg-subtle);
`;

export function Shell() {
  const location = useLocation();
  const navigate = useNavigate();

  // Save current path per module so we can restore it when switching back
  useEffect(() => {
    const subApps = ["/life", "/shopping", "/recipes", "/travel", "/upkeep"];
    for (const app of subApps) {
      if (location.pathname.startsWith(app)) {
        localStorage.setItem(LAST_PATH_KEY, location.pathname);
        localStorage.setItem(`home:lastPath:${app}`, location.pathname);
        break;
      }
    }
  }, [location.pathname]);

  const isActive = (path: string) => location.pathname.startsWith(path);

  /** Navigate to a module, restoring the last visited path within it. */
  const goTo = (basePath: string) => {
    const last = localStorage.getItem(`home:lastPath:${basePath}`);
    navigate(last && last !== basePath ? last : basePath);
  };

  const handleSignOut = () => {
    getBackend().authStore.clear();
    navigate("/");
  };

  return (
    <Container>
      <Header>
        <Nav>
          <NavButton
            $active={isActive("/life")}
            onClick={() => goTo("/life")}
          >
            <NavIcon $active={isActive("/life")}><ExperimentOutlined /></NavIcon>
            <span className="nav-label">Life</span>
          </NavButton>
          <NavButton
            $active={isActive("/recipes")}
            onClick={() => goTo("/recipes")}
          >
            <NavIcon $active={isActive("/recipes")}><BookOutlined /></NavIcon>
            <span className="nav-label">Recipes</span>
          </NavButton>
          <NavButton
            $active={isActive("/shopping")}
            onClick={() => goTo("/shopping")}
          >
            <NavIcon $active={isActive("/shopping")}><ShoppingCartOutlined /></NavIcon>
            <span className="nav-label">Shopping</span>
          </NavButton>
          <NavButton
            $active={isActive("/travel")}
            onClick={() => goTo("/travel")}
          >
            <NavIcon $active={isActive("/travel")}><CompassOutlined /></NavIcon>
            <span className="nav-label">Travel</span>
          </NavButton>
          <NavButton
            $active={isActive("/upkeep")}
            onClick={() => goTo("/upkeep")}
          >
            <NavIcon $active={isActive("/upkeep")}><CheckSquareOutlined /></NavIcon>
            <span className="nav-label">Upkeep</span>
          </NavButton>
          <NavButton
            $active={isActive("/timeline")}
            onClick={() => navigate("/timeline")}
          >
            <NavIcon $active={isActive("/timeline")}><HistoryOutlined /></NavIcon>
            <span className="nav-label">Timeline</span>
          </NavButton>
        </Nav>
        <HeaderActions>
          <Tooltip title="Settings">
            <IconButton onClick={() => navigate("/settings")}>
              <SettingOutlined />
            </IconButton>
          </Tooltip>
          <Tooltip title="Sign out">
            <IconButton onClick={handleSignOut}>
              <LogoutOutlined />
            </IconButton>
          </Tooltip>
        </HeaderActions>
      </Header>
      <Content>
        <Outlet />
      </Content>
    </Container>
  );
}
