import { useState } from "react";
import { Button, Input } from "antd";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  PlusOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { updateCategories } from "../firestore";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const Header = styled.header`
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--color-primary);
  color: white;
`;

const Title = styled.h1`
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
`;

const Content = styled.main`
  flex: 1;
  padding: var(--space-md);
`;

const CategoryList = styled.div`
  margin-bottom: var(--space-lg);
`;

const CategoryRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-xs);
`;

const CategoryName = styled.span`
  flex: 1;
  font-size: var(--font-size-base);
  text-transform: capitalize;
`;

const AddRow = styled.div`
  display: flex;
  gap: var(--space-sm);
`;

interface Props {
  categories: string[];
  onBack: () => void;
}

export function CategorySettings({ categories, onBack }: Props) {
  const [newCategory, setNewCategory] = useState("");
  const [localCategories, setLocalCategories] = useState(categories);

  const handleAdd = () => {
    const trimmed = newCategory.trim().toLowerCase();
    if (!trimmed || localCategories.includes(trimmed)) return;

    const updated = [...localCategories, trimmed];
    setLocalCategories(updated);
    updateCategories(updated);
    setNewCategory("");
  };

  const handleRemove = (cat: string) => {
    const updated = localCategories.filter((c) => c !== cat);
    setLocalCategories(updated);
    updateCategories(updated);
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const updated = [...localCategories];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    setLocalCategories(updated);
    updateCategories(updated);
  };

  const handleMoveDown = (index: number) => {
    if (index === localCategories.length - 1) return;
    const updated = [...localCategories];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    setLocalCategories(updated);
    updateCategories(updated);
  };

  return (
    <Container>
      <Header>
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
          style={{ color: "white" }}
        />
        <Title>Categories</Title>
      </Header>
      <Content>
        <CategoryList>
          {localCategories.map((cat, index) => (
            <CategoryRow key={cat}>
              <CategoryName>{cat}</CategoryName>
              <Button
                type="text"
                size="small"
                icon={<ArrowUpOutlined />}
                onClick={() => handleMoveUp(index)}
                disabled={index === 0}
              />
              <Button
                type="text"
                size="small"
                icon={<ArrowDownOutlined />}
                onClick={() => handleMoveDown(index)}
                disabled={index === localCategories.length - 1}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleRemove(cat)}
              />
            </CategoryRow>
          ))}
        </CategoryList>
        <AddRow>
          <Input
            placeholder="New category..."
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onPressEnter={handleAdd}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleAdd}
            disabled={!newCategory.trim()}
          >
            Add
          </Button>
        </AddRow>
      </Content>
    </Container>
  );
}
