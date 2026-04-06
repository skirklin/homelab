import { useState, useMemo, useRef } from "react";
import { AutoComplete, Button, Input } from "antd";
import type { BaseSelectRef } from "rc-select";
import { PlusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { useGroceriesContext } from "../groceries-context";
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

const IngredientWrapper = styled.div`
  flex: 2;
`;

const NoteWrapper = styled.div`
  flex: 1;
`;

export function AddItem() {
  const { user } = useAuth();
  const { state } = useGroceriesContext();
  const [ingredient, setIngredient] = useState("");
  const [note, setNote] = useState("");
  const inputRef = useRef<BaseSelectRef>(null);

  // Filter history for autocomplete options (based on ingredient)
  const autocompleteOptions = useMemo(() => {
    if (!ingredient.trim()) return [];

    const searchTerm = ingredient.toLowerCase();
    const existingItems = getItemsFromState(state);
    const existingIngredients = new Set(existingItems.map((i) => i.ingredient.toLowerCase()));

    return state.history
      .filter(
        (h) =>
          h.ingredient.toLowerCase().includes(searchTerm) &&
          !existingIngredients.has(h.ingredient.toLowerCase())
      )
      .slice(0, 8)
      .map((h) => ({
        value: h.ingredient,
        label: h.ingredient,
      }));
  }, [ingredient, state.history, state.items]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitItem();
  };

  const submitItem = () => {
    const trimmedIngredient = ingredient.trim();
    if (!trimmedIngredient || !user) return;

    // Check for duplicates (case-insensitive, based on ingredient only)
    const existingItems = getItemsFromState(state);
    const duplicate = existingItems.find(
      (item) => item.ingredient.toLowerCase() === trimmedIngredient.toLowerCase()
    );

    if (duplicate) {
      alert(`"${duplicate.ingredient}" is already on the list`);
      return;
    }

    // Clear immediately for fast typing
    setIngredient("");
    setNote("");

    // Return focus to input for rapid entry
    inputRef.current?.focus();

    // Look up category from local history (already loaded via subscription)
    const normalizedIngredient = trimmedIngredient.toLowerCase();
    const historyEntry = state.history.find(
      (h) => h.ingredient.toLowerCase() === normalizedIngredient
    );
    const categoryId = historyEntry?.categoryId || "uncategorized";

    // Fire and forget - pass category to skip network lookup
    const trimmedNote = note.trim() || undefined;
    addItem(trimmedIngredient, user.uid, { categoryId, note: trimmedNote }).catch((error) => {
      console.error("Failed to add item:", error);
    });
  };

  return (
    <Container>
      <Form onSubmit={handleSubmit}>
        <IngredientWrapper>
          <AutoComplete
            ref={inputRef}
            value={ingredient}
            onChange={setIngredient}
            onSelect={(value) => setIngredient(value)}
            options={autocompleteOptions}
            placeholder="Item..."
            size="large"
            style={{ width: "100%" }}
            autoFocus
          />
        </IngredientWrapper>
        <NoteWrapper>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note"
            size="large"
          />
        </NoteWrapper>
        <Button
          type="primary"
          htmlType="submit"
          size="large"
          icon={<PlusOutlined />}
          disabled={!ingredient.trim()}
        >
          Add
        </Button>
      </Form>
    </Container>
  );
}
