/**
 * Join list page for shopping app - uses shared JoinList component.
 */

import { JoinList as SharedJoinList, type JoinListConfig, type ListOperations, getListInfo } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { useUserBackend } from "@kirkl/shared";

const config: JoinListConfig = {
  title: "Join List",
  errorTitle: "List Not Found",
  slugPlaceholder: "shopping",
};

export function JoinList() {
  const { state } = useShoppingContext();
  const userBackend = useUserBackend();

  const operations: ListOperations = {
    getUserSlugs: () => state.userSlugs,
    createList: async () => { throw new Error("Not implemented"); },
    setUserSlug: async (userId: string, slug: string, listId: string) => {
      await userBackend.setSlug(userId, "shopping", slug, listId);
    },
    getListById: (listId: string) => getListInfo("shopping_lists", listId),
  };

  return (
    <SharedJoinList
      config={config}
      operations={operations}
    />
  );
}
