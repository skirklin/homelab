/**
 * Join list page for shopping app - uses shared JoinList component.
 */

import { JoinList as SharedJoinList, type JoinListConfig, type ListOperations } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { useShoppingBackend, useUserBackend } from "@kirkl/shared";

const config: JoinListConfig = {
  title: "Join List",
  errorTitle: "List Not Found",
  slugPlaceholder: "shopping",
};

export function JoinList() {
  const { state } = useShoppingContext();
  const shopping = useShoppingBackend();
  const userBackend = useUserBackend();

  const operations: ListOperations = {
    getUserSlugs: () => state.userSlugs,
    createList: async () => { throw new Error("Not implemented"); }, // Not used in JoinList
    setUserSlug: async (userId: string, slug: string, listId: string) => {
      await userBackend.setSlug(userId, "shopping", slug, listId);
    },
    getListById: async (listId: string) => {
      const list = await shopping.getList(listId);
      return list ? { name: list.name } : null;
    },
  };

  return (
    <SharedJoinList
      config={config}
      operations={operations}
    />
  );
}
