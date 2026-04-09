/**
 * List picker for upkeep app - uses shared ListPicker component.
 */

import { ListPicker as SharedListPicker, type ListPickerConfig, type ListOperations } from "@kirkl/shared";
import { useUpkeepContext } from "../upkeep-context";
import { useUpkeepBackend, useUserBackend } from "@kirkl/shared";
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
  const upkeep = useUpkeepBackend();
  const userBackend = useUserBackend();

  const operations: ListOperations = {
    getUserSlugs: () => state.userSlugs,
    createList: async (name: string, slug: string, userId: string) => {
      const listId = await upkeep.createList(name, userId);
      await userBackend.setSlug(userId, "household", slug, listId);
      return listId;
    },
    setUserSlug: async (userId: string, slug: string, listId: string) => {
      await userBackend.setSlug(userId, "household", slug, listId);
    },
    getListById: async (listId: string) => {
      const list = await upkeep.getList(listId);
      return list ? { name: list.name } : null;
    },
  };

  return (
    <SharedListPicker
      config={config}
      operations={operations}
      storage={appStorage}
    />
  );
}
