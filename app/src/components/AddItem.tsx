import { useState } from "react";
import { Input, Select, Button, Space } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAppContext } from "../context";
import { addItem } from "../firestore";
import { getItemsFromState } from "../subscription";
import { CATEGORIES, CATEGORY_LABELS } from "../types";
import type { Category } from "../types";

const Container = styled.div`
  padding: var(--space-md);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
`;

const Form = styled.form`
  display: flex;
  gap: var(--space-sm);

  @media (max-width: 480px) {
    flex-direction: column;
  }
`;

const InputWrapper = styled.div`
  flex: 1;
`;

export function AddItem() {
  const { state } = useAppContext();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("other");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || !state.authUser) return;

    // Check for duplicates (case-insensitive)
    const existingItems = getItemsFromState(state);
    const duplicate = existingItems.find(
      (item) => item.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (duplicate) {
      alert(`"${duplicate.name}" is already on the list`);
      return;
    }

    // Clear immediately for fast typing
    setName("");

    // Fire and forget - don't await
    addItem(trimmedName, category, state.authUser.uid).catch((error) => {
      console.error("Failed to add item:", error);
    });
  };

  return (
    <Container>
      <Form onSubmit={handleSubmit}>
        <InputWrapper>
          <Input
            placeholder="Add item..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            size="large"
            autoFocus
          />
        </InputWrapper>
        <Space.Compact>
          <Select
            value={category}
            onChange={setCategory}
            size="large"
            style={{ width: 140 }}
            showSearch
            filterOption={(input, option) =>
              (option?.label ?? "").toLowerCase().includes(input.toLowerCase())
            }
            options={CATEGORIES.map((cat) => ({
              value: cat,
              label: CATEGORY_LABELS[cat],
            }))}
          />
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            icon={<PlusOutlined />}
            disabled={!name.trim()}
          >
            Add
          </Button>
        </Space.Compact>
      </Form>
    </Container>
  );
}
