/**
 * List picker for shopping app - uses shared ListPicker component.
 */

import { ListPicker as SharedListPicker, type ListPickerConfig, type ListOperations } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { createList, setUserSlug, getListById } from "../pocketbase";
import { appStorage, StorageKeys } from "../storage";

const config: ListPickerConfig = {
  title: "My Lists",
  newListLabel: "New List",
  newListPlaceholder: "Shopping",
  createModalTitle: "Create New List",
  emptyMessage: ["No lists yet.", "Create a new list to get started!"],
  lastListKey: StorageKeys.LAST_LIST,
};

export function ListPicker() {
  const { state } = useShoppingContext();

  const operations: ListOperations = {
    getUserSlugs: () => state.userSlugs,
    createList,
    setUserSlug,
    getListById,
  };

  return (
    <SharedListPicker
      config={config}
      operations={operations}
      storage={appStorage}
    />
  );
}
