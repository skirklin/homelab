/**
 * Join list page for groceries app - uses shared JoinList component.
 */

import { JoinList as SharedJoinList, type JoinListConfig, type ListOperations } from "@kirkl/shared";
import { useGroceriesContext } from "../groceries-context";
import { setUserSlug, getListById } from "../firestore";

const config: JoinListConfig = {
  title: "Join List",
  errorTitle: "List Not Found",
  slugPlaceholder: "groceries",
};

export function JoinList() {
  const { state } = useGroceriesContext();

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
