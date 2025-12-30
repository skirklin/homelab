import React from 'react';
import { User } from "firebase/auth";
import { getDoc, onSnapshot, doc, setDoc, DocumentSnapshot, collection, QuerySnapshot, updateDoc, arrayRemove } from "firebase/firestore";

import { ActionType, BoxId, UnsubMap, Visibility } from './types';

import { db } from './backend'
import { addBox, subscribeToBox } from './firestore';
import { boxConverter, BoxEntry, recipeConverter, RecipeEntry, userConverter, UserEntry } from './storage';

// Track in-progress initializations to prevent React Strict Mode double-init
const initializingUsers = new Set<string>();

async function initializeUser(user: User) {
  // Prevent concurrent initialization for the same user
  if (initializingUsers.has(user.uid)) {
    // Wait a bit and re-fetch the user doc (another init is in progress)
    await new Promise(resolve => setTimeout(resolve, 100));
    const userRef = doc(db, "users", user.uid).withConverter(userConverter);
    return userRef;
  }

  initializingUsers.add(user.uid);
  try {
    const userRef = doc(db, "users", user.uid).withConverter(userConverter);
    const userDoc = await getDoc(userRef)
    if (!userDoc.exists()) {
      await setDoc(userRef, new UserEntry(user.displayName || "Anonymous", Visibility.private, [], new Date(), new Date(), userRef.id));
      const newUser = await getDoc(userRef)
      if (newUser.exists()) {
        const userEntry = newUser.data()
        const userBoxRef = await addBox(userEntry, `${user.displayName}'s box`);
        if (userBoxRef !== undefined) {
          await subscribeToBox(newUser.data() || null, userBoxRef.id)
        }
      }
    } else {
      const data = userDoc.data()
      await updateDoc(userRef, { newSeen: new Date(), lastSeen: data.newSeen || new Date() })
    }
    return userRef
  } finally {
    initializingUsers.delete(user.uid);
  }
}

export async function subscribeToUser(user: User, dispatch: React.Dispatch<ActionType>, unsubMap: UnsubMap) {
  dispatch({ type: "INCR_LOADING" })
  // fetch any boxes associated with this user
  if (user === null) {
    return
  }

  const userRef = await initializeUser(user)

  // subscription for changes to user
  unsubMap.userUnsub = onSnapshot(userRef.withConverter(userConverter),
    snapshot => (handleUserSnapshot(snapshot, dispatch, unsubMap))
  )
  dispatch({ type: "DECR_LOADING" })
}

async function handleUserSnapshot(
  snapshot: DocumentSnapshot<UserEntry>,
  dispatch: React.Dispatch<ActionType>,
  unsubMap: UnsubMap,
) {
  const user = snapshot.data()
  if (user === undefined) {
    return
  }
  dispatch({ type: "INCR_LOADING" })

  dispatch({ type: "ADD_USER", user })

  user.boxes.forEach(
    (bid: string) => {
      if (!unsubMap.boxMap.has(bid)) {
        const boxRef = doc(db, "boxes", bid).withConverter(boxConverter)

        // Track loading state for this box
        let boxLoaded = false;
        let recipesLoaded = false;
        const pendingRecipeSnapshots: QuerySnapshot<RecipeEntry>[] = [];

        // Increment loading for this box's data
        dispatch({ type: "INCR_LOADING" })

        const decrementOnceLoaded = () => {
          if (boxLoaded && recipesLoaded) {
            dispatch({ type: "DECR_LOADING" })
          }
        }

        const boxUnsub = onSnapshot(
          boxRef.withConverter(boxConverter),
          (snapshot) => {
            handleBoxSnapshot(snapshot, dispatch, unsubMap)
            // Process any pending recipe snapshots after box is loaded
            if (!boxLoaded) {
              boxLoaded = true;
              pendingRecipeSnapshots.forEach(recipeSnapshot => {
                handleRecipesSnapshot(recipeSnapshot, dispatch, boxRef.id)
              });
              pendingRecipeSnapshots.length = 0;
              decrementOnceLoaded();
            }
          },
          (error) => {
            console.error(`Error loading box ${bid}:`, error);
            // Remove stale box reference from user's boxes array
            const userRef = doc(db, "users", user.id);
            updateDoc(userRef, { boxes: arrayRemove(boxRef) }).catch(e => console.error("Failed to remove stale box:", e));
            if (!boxLoaded) {
              boxLoaded = true;
              decrementOnceLoaded();
            }
          }
        )

        const recipesRef = collection(db, "boxes", boxRef.id, "recipes").withConverter(recipeConverter)
        const recipesUnsub = onSnapshot(
          recipesRef,
          (snapshot) => {
            if (boxLoaded) {
              handleRecipesSnapshot(snapshot, dispatch, boxRef.id)
            } else {
              // Queue until box is loaded
              pendingRecipeSnapshots.push(snapshot);
            }
            if (!recipesLoaded) {
              recipesLoaded = true;
              decrementOnceLoaded();
            }
          },
          (error) => {
            console.error(`Error loading recipes for box ${bid}:`, error);
            // Remove stale box reference from user's boxes array
            const userRef = doc(db, "users", user.id);
            updateDoc(userRef, { boxes: arrayRemove(boxRef) }).catch(e => console.error("Failed to remove stale box:", e));
            if (!recipesLoaded) {
              recipesLoaded = true;
              decrementOnceLoaded();
            }
          }
        )
        unsubMap.boxMap.set(boxRef.id, { recipesUnsub, boxUnsub })
      }
    }
  )
  dispatch({ type: "DECR_LOADING" })

}

async function handleRecipesSnapshot(snapshot: QuerySnapshot<RecipeEntry>, dispatch: React.Dispatch<ActionType>, boxId: BoxId) {
  const changes = snapshot.docChanges()
  for (const change of changes) {
    const doc = change.doc;
    const data = doc.data()
    if (change.type === "added" || change.type === "modified") {
      dispatch({ type: "ADD_RECIPE", recipeId: doc.id, boxId, payload: data })
    } else {
      dispatch({ type: "REMOVE_RECIPE", recipeId: doc.id, boxId })
    }
  }
}

async function handleBoxSnapshot(
  snapshot: DocumentSnapshot<BoxEntry>,
  dispatch: React.Dispatch<ActionType>,
  unsubMap: UnsubMap,
) {
  const box = snapshot.data()

  if (box === undefined) {
    dispatch({ type: "REMOVE_BOX", boxId: snapshot.id })
    return
  }

  dispatch({ type: "ADD_BOX", boxId: snapshot.id, payload: box })
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
