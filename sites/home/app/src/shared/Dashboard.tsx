import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Card } from "antd";
import {
  ExperimentOutlined,
  ShoppingCartOutlined,
  CheckSquareOutlined,
  BookOutlined,
} from "@ant-design/icons";

const Container = styled.div`
  padding: var(--space-lg);
  max-width: 800px;
  margin: 0 auto;
`;

const Title = styled.h1`
  margin-bottom: var(--space-lg);
  color: var(--color-text);
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-md);
`;

const AppCard = styled(Card)`
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }
`;

const AppIcon = styled.div<{ $color: string }>`
  font-size: 32px;
  margin-bottom: var(--space-sm);
  color: ${props => props.$color};
`;

const AppName = styled.div`
  font-weight: 600;
  font-size: var(--font-size-lg);
`;

const AppDescription = styled.div`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
`;

const apps = [
  {
    name: "Life Tracker",
    description: "Track sleep, gym, stretching, and work",
    icon: <ExperimentOutlined />,
    color: "#7c3aed",
    path: "/life",
  },
  {
    name: "Recipes",
    description: "Your recipe collection",
    icon: <BookOutlined />,
    color: "#2ca6a4",
    path: "/recipes",
  },
  {
    name: "Groceries",
    description: "Shopping lists",
    icon: <ShoppingCartOutlined />,
    color: "#2ca6a4",
    path: "/groceries",
  },
  {
    name: "Upkeep",
    description: "Household tasks",
    icon: <CheckSquareOutlined />,
    color: "#5c7cfa",
    path: "/upkeep",
  },
];

export function Dashboard() {
  const navigate = useNavigate();

  const handleClick = (app: typeof apps[0]) => {
    navigate(app.path);
  };

  return (
    <Container>
      <Title>Welcome Home</Title>
      <Grid>
        {apps.map((app) => (
          <AppCard key={app.name} onClick={() => handleClick(app)}>
            <AppIcon $color={app.color}>{app.icon}</AppIcon>
            <AppName>{app.name}</AppName>
            <AppDescription>{app.description}</AppDescription>
          </AppCard>
        ))}
      </Grid>
    </Container>
  );
}
