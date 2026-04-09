/**
 * Join list page for upkeep app - uses shared JoinList component.
 */

import { JoinList as SharedJoinList, type JoinListConfig, type ListOperations } from "@kirkl/shared";
import { useUpkeepContext } from "../upkeep-context";
import { useUpkeepBackend, useUserBackend } from "../backend-provider";

const config: JoinListConfig = {
  title: "Join Task List",
  errorTitle: "Cannot Join List",
  slugPlaceholder: "home",
};

export function JoinList() {
  const { state } = useUpkeepContext();
  const upkeep = useUpkeepBackend();
  const userBackend = useUserBackend();

  const operations: ListOperations = {
    getUserSlugs: () => state.userSlugs,
    createList: async () => { throw new Error("Not implemented"); }, // Not used in JoinList
    setUserSlug: async (userId: string, slug: string, listId: string) => {
      await userBackend.setSlug(userId, "household", slug, listId);
    },
    getListById: async (listId: string) => {
      const list = await upkeep.getList(listId);
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
