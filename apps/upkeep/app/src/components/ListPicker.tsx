/**
 * List picker for upkeep app - uses shared ListPicker component.
 */

import { ListPicker as SharedListPicker, type ListPickerConfig, type ListOperations } from "@kirkl/shared";
import { useUpkeepContext } from "../upkeep-context";
import { createList, setUserSlug, getListById } from "../pocketbase";
import { appStorage, StorageKeys } from "../storage";

const config: ListPickerConfig = {
  title: "Upkeep",
  newListLabel: "New Task List",
  newListPlaceholder: "Home Maintenance",
  createModalTitle: "Create New Task List",
  emptyMessage: ["No task lists yet.", "Create a new list to start tracking your tasks!"],
  lastListKey: StorageKeys.LAST_LIST,
};

export function ListPicker() {
  const { state } = useUpkeepContext();

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
