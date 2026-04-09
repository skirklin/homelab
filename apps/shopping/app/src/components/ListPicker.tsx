/**
 * List picker for shopping app - uses shared ListPicker component.
 */

import { ListPicker as SharedListPicker, type ListPickerConfig, type ListOperations } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { useShoppingBackend, useUserBackend } from "@kirkl/shared";
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
  const shopping = useShoppingBackend();
  const userBackend = useUserBackend();

  const operations: ListOperations = {
    getUserSlugs: () => state.userSlugs,
    createList: async (name: string, slug: string, userId: string) => {
      const listId = await shopping.createList(name, userId);
      await userBackend.setSlug(userId, "shopping", slug, listId);
      return listId;
    },
    setUserSlug: async (userId: string, slug: string, listId: string) => {
      await userBackend.setSlug(userId, "shopping", slug, listId);
    },
    getListById: async (listId: string) => {
      const list = await shopping.getList(listId);
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
