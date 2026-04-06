import { Input, Modal, Select, message } from "antd";
import { useState, useEffect } from "react";
import styled from "styled-components";
import type { GroceriesIntegration } from "../GroceriesIntegrationContext";

const FormGroup = styled.div`
  margin-bottom: var(--space-md);
`;

const Label = styled.label`
  display: block;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: var(--space-xs);
`;

const InputRow = styled.div`
  display: flex;
  gap: var(--space-sm);
`;

const IngredientInput = styled(Input)`
  flex: 2;
`;

const NoteInput = styled(Input)`
  flex: 1;
`;

interface AddToGroceriesModalProps {
  isVisible: boolean;
  setIsVisible: (visible: boolean) => void;
  ingredient: string;
  integration: GroceriesIntegration;
}

export function AddToGroceriesModal({
  isVisible,
  setIsVisible,
  ingredient,
  integration,
}: AddToGroceriesModalProps) {
  const [itemIngredient, setItemIngredient] = useState(ingredient);
  const [itemNote, setItemNote] = useState("");
  const [selectedListId, setSelectedListId] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isVisible) {
      setItemIngredient(ingredient);
      setItemNote("");
      // Default to current list, or first list if only one exists
      if (integration.currentListId) {
        setSelectedListId(integration.currentListId);
      } else {
        const listIds = Object.values(integration.userSlugs);
        if (listIds.length === 1) {
          setSelectedListId(listIds[0]);
        }
      }
    }
  }, [isVisible, ingredient, integration.currentListId, integration.userSlugs]);

  const listOptions = Object.entries(integration.userSlugs).map(
    ([slug, listId]) => ({
      value: listId,
      label: slug,
    })
  );

  const handleAdd = async () => {
    if (!itemIngredient.trim() || !selectedListId) return;

    setLoading(true);
    try {
      const trimmedIngredient = itemIngredient.trim();
      const trimmedNote = itemNote.trim() || undefined;
      await integration.addItem(selectedListId, trimmedIngredient, trimmedNote);
      message.success(`Added "${trimmedIngredient}" to grocery list`);
      setIsVisible(false);
    } catch {
      message.error("Failed to add item to grocery list");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setIsVisible(false);
    setItemIngredient("");
    setItemNote("");
    setSelectedListId("");
  };

  return (
    <Modal
      title="Add to Grocery List"
      open={isVisible}
      onOk={handleAdd}
      onCancel={handleClose}
      okText="Add to List"
      okButtonProps={{
        disabled: !itemIngredient.trim() || !selectedListId,
        loading,
      }}
      destroyOnClose
    >
      <FormGroup>
        <Label>Item</Label>
        <InputRow>
          <IngredientInput
            value={itemIngredient}
            onChange={(e) => setItemIngredient(e.target.value)}
            placeholder="Ingredient"
            onPressEnter={handleAdd}
          />
          <NoteInput
            value={itemNote}
            onChange={(e) => setItemNote(e.target.value)}
            placeholder="Note (optional)"
            onPressEnter={handleAdd}
          />
        </InputRow>
      </FormGroup>
      <FormGroup>
        <Label>Grocery list</Label>
        <Select
          style={{ width: "100%" }}
          value={selectedListId || undefined}
          onChange={setSelectedListId}
          placeholder="Select a list"
          options={listOptions}
        />
      </FormGroup>
    </Modal>
  );
}
