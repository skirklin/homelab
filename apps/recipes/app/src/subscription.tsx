/**
 * PocketBase real-time subscriptions for the recipes app.
 * Uses shared subscription helpers from @kirkl/shared.
 */
import type React from 'react';
import { subscribeToRecord, subscribeToCollection, useAuth } from "@kirkl/shared";

/** Auth user type — matches the shape from @kirkl/shared's useAuth() */
type User = NonNullable<ReturnType<typeof useAuth>["user"]>;

import { type ActionType, type UnsubMap } from './types';

import { boxFromRecord, recipeFromRecord, UserEntry, userFromRecord } from './storage';

export function subscribeToUser(user: User, dispatch: React.Dispatch<ActionType>, unsubMap: UnsubMap, cancelled: () => boolean) {
  if (user === null) {
    return;
  }

  let initialLoad = true;
  unsubMap.userUnsub = subscribeToRecord("users", user.uid, cancelled, {
    onData: (record) => {
      const userEntry = userFromRecord(record);
      dispatch({ type: "ADD_USER", user: userEntry });
      setupBoxSubscriptions(userEntry, dispatch, unsubMap, cancelled);
      if (initialLoad) {
        initialLoad = false;
        dispatch({ type: "SET_LOADING", loading: 0 });
      }
    },
    onError: (err) => {
      console.error("[recipes] subscribeToUser failed:", err);
    },
  });
}

function setupBoxSubscriptions(
  user: UserEntry,
  dispatch: React.Dispatch<ActionType>,
  unsubMap: UnsubMap,
  cancelled: () => boolean,
) {
  for (const boxId of user.boxes) {
    if (cancelled()) return;
    if (unsubMap.boxMap.has(boxId)) continue;

    const boxUnsub = subscribeToRecord("recipe_boxes", boxId, cancelled, {
      onData: (record) => {
        const box = boxFromRecord(record);
        dispatch({ type: "ADD_BOX", boxId, payload: box });
      },
      onDelete: () => {
        dispatch({ type: "REMOVE_BOX", boxId });
      },
      onError: (err) => {
        console.error(`Error loading box ${boxId}:`, err);
      },
    });

    const recipesUnsub = subscribeToCollection("recipes", cancelled, {
      filter: `box = "${boxId}"`,
      belongsTo: (r) => r.box === boxId,
      onInitial: (records) => {
        for (const recipeRecord of records) {
          const recipe = recipeFromRecord(recipeRecord);
          dispatch({ type: "ADD_RECIPE", recipeId: recipeRecord.id, boxId, payload: recipe });
        }
      },
      onChange: (action, record) => {
        if (action === "delete") {
          dispatch({ type: "REMOVE_RECIPE", recipeId: record.id, boxId });
        } else {
          const recipe = recipeFromRecord(record);
          dispatch({ type: "ADD_RECIPE", recipeId: record.id, boxId, payload: recipe });
        }
      },
      onError: (err) => {
        console.error(`Error loading recipes for box ${boxId}:`, err);
      },
    });

    unsubMap.boxMap.set(boxId, { boxUnsub, recipesUnsub });
  }
}


export function unsubscribe(unsubMap: UnsubMap) {
  unsubMap.userUnsub && unsubMap.userUnsub();
  unsubMap.boxesUnsub && unsubMap.boxesUnsub();
  for (const box of unsubMap.boxMap.values()) {
    box.boxUnsub && box.boxUnsub();
    box.recipesUnsub && box.recipesUnsub();
  }
  unsubMap.userUnsub = undefined;
  unsubMap.boxesUnsub = undefined;
  unsubMap.boxMap.clear();
}
