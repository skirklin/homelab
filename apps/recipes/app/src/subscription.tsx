/**
 * PocketBase real-time subscriptions for the recipes app.
 * Replaces Firestore onSnapshot listeners with PocketBase SSE subscriptions.
 */
import type React from 'react';
import type { RecordSubscription, RecordModel } from "pocketbase";
import { getBackend, useAuth } from "@kirkl/shared";

/** Auth user type — matches the shape from @kirkl/shared's useAuth() */
type User = NonNullable<ReturnType<typeof useAuth>["user"]>;

import { type ActionType, type UnsubMap } from './types';

import { boxFromRecord, recipeFromRecord, UserEntry, userFromRecord } from './storage';

function pb() {
  return getBackend();
}

export async function subscribeToUser(user: User, dispatch: React.Dispatch<ActionType>, unsubMap: UnsubMap, cancelled: () => boolean) {
  if (user === null) {
    return;
  }

  try {
    const userRecord = await pb().collection("users").getOne(user.uid, { $autoCancel: false });
    if (cancelled()) return;
    const userEntry = userFromRecord(userRecord);
    dispatch({ type: "ADD_USER", user: userEntry });

    // Subscribe to user record changes
    pb().collection("users").subscribe(user.uid, (e: RecordSubscription<RecordModel>) => {
      if (cancelled()) return;
      if (e.action === "delete") return;
      const updatedUser = userFromRecord(e.record);
      dispatch({ type: "ADD_USER", user: updatedUser });
      setupBoxSubscriptions(updatedUser, dispatch, unsubMap, cancelled);
    });
    unsubMap.userUnsub = () => pb().collection("users").unsubscribe(user.uid);

    await setupBoxSubscriptions(userEntry, dispatch, unsubMap, cancelled);
  } catch (err) {
    console.error("[recipes] subscribeToUser failed:", err);
  }
}

async function setupBoxSubscriptions(
  user: UserEntry,
  dispatch: React.Dispatch<ActionType>,
  unsubMap: UnsubMap,
  cancelled: () => boolean,
) {
  for (const boxId of user.boxes) {
    if (cancelled()) return;
    if (!unsubMap.boxMap.has(boxId)) {
      // Fetch box — disable auto-cancel for initialization
      try {
        const boxRecord = await pb().collection("recipe_boxes").getOne(boxId, { $autoCancel: false });
        if (cancelled()) return;
        const box = boxFromRecord(boxRecord);
        dispatch({ type: "ADD_BOX", boxId, payload: box });
      } catch (error) {
        console.error(`Error loading box ${boxId}:`, error);
        continue;
      }

      // Subscribe to box changes
      pb().collection("recipe_boxes").subscribe(boxId, (e: RecordSubscription<RecordModel>) => {
        if (cancelled()) return;
        if (e.action === "delete") {
          dispatch({ type: "REMOVE_BOX", boxId });
        } else {
          const box = boxFromRecord(e.record);
          dispatch({ type: "ADD_BOX", boxId, payload: box });
        }
      });

      // Fetch recipes for this box
      try {
        const recipes = await pb().collection("recipes").getFullList({
          filter: `box = "${boxId}"`,
          $autoCancel: false,
        });
        if (cancelled()) return;
        for (const recipeRecord of recipes) {
          const recipe = recipeFromRecord(recipeRecord);
          dispatch({ type: "ADD_RECIPE", recipeId: recipeRecord.id, boxId, payload: recipe });
        }
      } catch (error) {
        console.error(`Error loading recipes for box ${boxId}:`, error);
      }

      // Subscribe to recipe changes for this box
      // We subscribe to all recipes and filter by box ID
      pb().collection("recipes").subscribe("*", (e: RecordSubscription<RecordModel>) => {
        if (cancelled()) return;
        if (e.record.box !== boxId) return;
        if (e.action === "delete") {
          dispatch({ type: "REMOVE_RECIPE", recipeId: e.record.id, boxId });
        } else {
          const recipe = recipeFromRecord(e.record);
          dispatch({ type: "ADD_RECIPE", recipeId: e.record.id, boxId, payload: recipe });
        }
      });

      unsubMap.boxMap.set(boxId, {
        boxUnsub: () => pb().collection("recipe_boxes").unsubscribe(boxId),
        recipesUnsub: () => pb().collection("recipes").unsubscribe("*"),
      });
    }
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
