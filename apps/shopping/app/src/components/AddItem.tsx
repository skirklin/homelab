import { useState, useMemo, useRef } from "react";
import { AutoComplete, Button, Input } from "antd";
import type { BaseSelectRef } from "rc-select";
import { PlusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAuth, useFeedback } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { useShoppingBackend } from "@kirkl/shared";
import { getItemsFromState } from "../selectors";
import { deriveSuggestions } from "../suggestions";
import { UNCATEGORIZED_CATEGORY_ID } from "../types";

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
  const { state } = useShoppingContext();
  const { message } = useFeedback();
  const shopping = useShoppingBackend();
  const [ingredient, setIngredient] = useState("");
  const [note, setNote] = useState("");
  const inputRef = useRef<BaseSelectRef>(null);

  // All trip-derived suggestions, keyed by normalized ingredient. This is the
  // single source of truth for both autocomplete and the on-add category
  // lookup — derived from `state.trips`, since `shopping_history` was retired.
  const suggestions = useMemo(() => deriveSuggestions(state.trips), [state.trips]);

  // Filter the suggestion map for the dropdown. Prefix matches rank above
  // substring matches so typing "b" shows items that start with "b" before
  // things that merely contain it. Within each rank, newest first so recent
  // additions stay reachable.
  const autocompleteOptions = useMemo(() => {
    if (!ingredient.trim()) return [];

    const searchTerm = ingredient.toLowerCase();
    const existingItems = getItemsFromState(state);
    const existingIngredients = new Set(existingItems.map((i) => i.ingredient.toLowerCase()));

    const matches: Array<{ key: string; ingredient: string; lastSeenMs: number }> = [];
    for (const [key, s] of suggestions) {
      if (existingIngredients.has(key)) continue;
      if (!key.includes(searchTerm)) continue;
      matches.push({ key, ingredient: s.ingredient, lastSeenMs: s.lastSeen.getTime() });
    }

    return matches
      .sort((a, b) => {
        const aPrefix = a.key.startsWith(searchTerm);
        const bPrefix = b.key.startsWith(searchTerm);
        if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
        return b.lastSeenMs - a.lastSeenMs;
      })
      .slice(0, 8)
      .map((m) => ({ value: m.ingredient, label: m.ingredient }));
  }, [ingredient, suggestions, state.items]);

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
      message.warning(`"${duplicate.ingredient}" is already on the list`);
      return;
    }

    // Clear immediately for fast typing
    setIngredient("");
    setNote("");

    // Return focus to input for rapid entry
    inputRef.current?.focus();

    // Look up category from trip-derived suggestions (loaded via subscription)
    const normalizedIngredient = trimmedIngredient.toLowerCase();
    const suggestion = suggestions.get(normalizedIngredient);
    const categoryId = suggestion?.categoryId || UNCATEGORIZED_CATEGORY_ID;

    // Fire and forget - pass category to skip network lookup. We don't
    // catch the promise: transient errors stay queued in wpb for automatic
    // retry on PB_CONNECT/focus, and permanent errors propagate as
    // unhandled WrappedPbError rejections that BackendProvider's global
    // useOptimisticErrorToast handler surfaces with a "Couldn't save"
    // message. A local .catch(console.error) here used to swallow both,
    // which is how silent data loss happened.
    const trimmedNote = note.trim() || undefined;
    const listId = state.list?.id;
    if (!listId) return;
    void shopping.addItem(listId, trimmedIngredient, user.uid, categoryId, trimmedNote);
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
