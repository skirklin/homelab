import { useState, useMemo, useRef } from "react";
import { AutoComplete, Button } from "antd";
import type { BaseSelectRef } from "rc-select";
import { PlusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAppContext } from "../context";
import { addItem } from "../firestore";
import { getItemsFromState } from "../subscription";

const Container = styled.div`
  padding: var(--space-md);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
`;

const Form = styled.form`
  display: flex;
  gap: var(--space-sm);
`;

const InputWrapper = styled.div`
  flex: 1;
`;

export function AddItem() {
  const { state } = useAppContext();
  const [name, setName] = useState("");
  const inputRef = useRef<BaseSelectRef>(null);

  // Filter history for autocomplete options
  const autocompleteOptions = useMemo(() => {
    if (!name.trim()) return [];

    const searchTerm = name.toLowerCase();
    const existingItems = getItemsFromState(state);
    const existingNames = new Set(existingItems.map((i) => i.name.toLowerCase()));

    return state.history
      .filter(
        (h) =>
          h.name.toLowerCase().includes(searchTerm) &&
          !existingNames.has(h.name.toLowerCase())
      )
      .slice(0, 8)
      .map((h) => ({
        value: h.name,
        label: h.name,
      }));
  }, [name, state.history, state.items]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitItem();
  };

  const submitItem = () => {
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

    // Return focus to input for rapid entry
    inputRef.current?.focus();

    // Fire and forget - addItem will lookup category from history
    addItem(trimmedName, state.authUser.uid).catch((error) => {
      console.error("Failed to add item:", error);
    });
  };

  return (
    <Container>
      <Form onSubmit={handleSubmit}>
        <InputWrapper>
          <AutoComplete
            ref={inputRef}
            value={name}
            onChange={setName}
            onSelect={(value) => setName(value)}
            options={autocompleteOptions}
            placeholder="Add item..."
            size="large"
            style={{ width: "100%" }}
            autoFocus
          />
        </InputWrapper>
        <Button
          type="primary"
          htmlType="submit"
          size="large"
          icon={<PlusOutlined />}
          disabled={!name.trim()}
        >
          Add
        </Button>
      </Form>
    </Container>
  );
}
