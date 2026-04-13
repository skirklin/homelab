/**
 * Join list page for upkeep app - uses shared JoinList component.
 */

import { JoinList as SharedJoinList, type JoinListConfig, type ListOperations, getListInfo } from "@kirkl/shared";
import { useUpkeepContext } from "../upkeep-context";
import { useUserBackend } from "@kirkl/shared";

const config: JoinListConfig = {
  title: "Join Task List",
  errorTitle: "Cannot Join List",
  slugPlaceholder: "home",
};

export function JoinList() {
  const { state } = useUpkeepContext();
  const userBackend = useUserBackend();

  const operations: ListOperations = {
    getUserSlugs: () => state.userSlugs,
    createList: async () => { throw new Error("Not implemented"); },
    setUserSlug: async (userId: string, slug: string, listId: string) => {
      await userBackend.setSlug(userId, "household", slug, listId);
    },
    getListById: (listId: string) => getListInfo("task_lists", listId),
  };

  return (
    <SharedJoinList
      config={config}
      operations={operations}
    />
  );
}
