/**
 * Join list page for upkeep app - uses shared JoinList component.
 */

import { JoinList as SharedJoinList, type JoinListConfig, type ListOperations } from "@kirkl/shared";
import { useUpkeepContext } from "../upkeep-context";
import { setUserSlug, getListById } from "../firestore";

const config: JoinListConfig = {
  title: "Join Task List",
  errorTitle: "Cannot Join List",
  slugPlaceholder: "home",
};

export function JoinList() {
  const { state } = useUpkeepContext();

  const operations: ListOperations = {
    getUserSlugs: () => state.userSlugs,
    createList: async () => { throw new Error("Not implemented"); }, // Not used in JoinList
    setUserSlug,
    getListById,
  };

  return (
    <SharedJoinList
      config={config}
      operations={operations}
    />
  );
}
