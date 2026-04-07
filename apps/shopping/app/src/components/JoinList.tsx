/**
 * Join list page for shopping app - uses shared JoinList component.
 */

import { JoinList as SharedJoinList, type JoinListConfig, type ListOperations } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { setUserSlug, getListById } from "../pocketbase";

const config: JoinListConfig = {
  title: "Join List",
  errorTitle: "List Not Found",
  slugPlaceholder: "shopping",
};

export function JoinList() {
  const { state } = useShoppingContext();

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
