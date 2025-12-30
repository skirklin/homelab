import { addDoc, arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';
import React from 'react';
import { Recipe } from "schema-dts"
import { db } from './backend';
import { boxConverter, BoxEntry, recipeConverter, RecipeEntry, userConverter, UserEntry } from './storage';
import { ActionType, AppState, BoxId, EnrichmentStatus, RecipeId, UserId, Visibility } from './types';

export async function getRecipe(state: AppState, boxId: BoxId | undefined, recipeId: RecipeId | undefined) {
  let recipe: RecipeEntry | undefined
  if (boxId === undefined || recipeId === undefined) {
    return undefined
  }
  const box = state.boxes.get(boxId);
  if (box !== undefined) {
    recipe = box.recipes.get(recipeId)
  } else {
    const ref = doc(db, "boxes", boxId, "recipes", recipeId).withConverter(recipeConverter)
    recipe = (await getDoc(ref)).data()
  }
  return recipe
}

export async function getRecipes(state: AppState, box: BoxEntry) {
  const user = state.authUser;
  const recipes = new Map<string, RecipeEntry>()
  if (user === null) {
    return recipes
  }
  const colRef = collection(db, "boxes", box.id as string, "recipes").withConverter(recipeConverter)
  if (box.visibility === "public" || box.owners.includes(user.uid)) {
    (await getDocs(colRef))
      .docs.forEach(doc => recipes.set(doc.id, doc.data()));
  } else {
    (await getDocs(query(colRef, where("owners", "array-contains", user.uid))))
      .docs.forEach(doc => recipes.set(doc.id, doc.data()));
    (await getDocs(query(colRef, where("visibility", "==", "public"))))
      .docs.forEach(doc => recipes.set(doc.id, doc.data()));
  }
  return recipes
}

export async function getBox(state: AppState, boxId: BoxId) {
  const boxRef = doc(db, "boxes", boxId).withConverter(boxConverter)
  const boxDoc = await getDoc(boxRef)
  if (!boxDoc.exists() || boxDoc.data() === undefined) {
    return undefined
  }
  const box = boxDoc.data()
  box.recipes = await getRecipes(state, box)
  return box
}

export async function getUser(state: AppState, userId: UserId) {
  const userRef = doc(db, "users", userId).withConverter(userConverter)
  const userDoc = await getDoc(userRef)
  if (!userDoc.exists() || userDoc.data() === undefined) {
    return undefined
  }
  const user = userDoc.data()
  return user
}

export async function subscribeToBox(user: UserEntry | null, boxId: BoxId) {
  if (user === null) {
    return undefined
  }
  const boxRef = doc(db, "boxes", boxId)
  const boxDoc = await getDoc(boxRef)
  if (!boxDoc.exists()) {
    return undefined
  }
  await updateDoc(doc(db, "users", user.id), { boxes: arrayUnion(boxRef) })
}


export async function unsubscribeFromBox(user: UserEntry | null, boxId: BoxId) {
  if (user === null) {
    return undefined
  }
  const boxRef = doc(db, "boxes", boxId)
  await updateDoc(doc(db, "users", user.id), { boxes: arrayRemove(boxRef) })
}

export async function uploadRecipes(boxId: BoxId, user: UserEntry) {
  const fileHandles = await window.showOpenFilePicker({
    multiple: true,
  })
  if (user === null) {
    return
  }
  for (const fh of fileHandles) {
    fh.getFile().then(f => {
      f.text().then(
        (text: string) => {
          const jsonobj = JSON.parse(text) as Recipe
          const recipe = new RecipeEntry(
            jsonobj,
            [user.id],
            Visibility.private,
            user.id,
            "placeholder",
            new Date(),
            new Date(),
            user.id,
          )
          addRecipe(boxId, recipe)
        })
    })
  }
}

export async function addRecipe(boxId: BoxId, recipe: RecipeEntry) {
  const colRef = collection(db, "boxes", boxId, "recipes").withConverter(recipeConverter)
  const recipeRef = await addDoc(colRef, recipe)
  return recipeRef
}

export async function addBox(user: UserEntry, name: string) {
  if (user === null) {
    return undefined
  }
  const boxesCol = collection(db, "boxes").withConverter(boxConverter)
  const boxData = { name }
  const box = new BoxEntry(boxData, [user.id], Visibility.private, user.id, "placeholder", new Date(), new Date(), user.id)
  const userRef = doc(db, "users", user.id)
  const boxRef = await addDoc(boxesCol, box)
  await updateDoc(userRef, { boxes: arrayUnion(boxRef) })
  return boxRef
}

export async function deleteRecipe(state: AppState, boxId: BoxId, recipeId: RecipeId, dispatch: React.Dispatch<ActionType>) {
  if (recipeId.startsWith("uniqueId=")) {
    const box = state.boxes.get(boxId)
    if (box !== undefined) {
      box.recipes.delete(recipeId)
    }
  } else {
    dispatch({ type: "REMOVE_RECIPE", boxId, recipeId })
    deleteDoc(doc(db, "boxes", boxId, "recipes", recipeId))
  }
}


export async function saveRecipe(boxId: BoxId, recipeId: RecipeId, recipe: RecipeEntry) {
  // Reset enrichment status so the recipe gets re-enriched after user edits
  recipe.enrichmentStatus = EnrichmentStatus.needed;
  recipe.pendingEnrichment = undefined;
  const docRef = doc(db, "boxes", boxId, "recipes", recipeId).withConverter(recipeConverter)
  setDoc(docRef, recipe)
  return docRef
}

export async function deleteBox(state: AppState, boxId: BoxId, dispatch: React.Dispatch<ActionType>) {
  dispatch({ type: "REMOVE_BOX", boxId })
  deleteDoc(doc(db, "boxes", boxId))
}

export async function setBoxVisibility(boxId: BoxId, visibility: Visibility) {
  updateDoc(doc(db, "boxes", boxId), { visibility })
}

export async function setRecipeVisibility(boxId: BoxId, recipeId: RecipeId, visibility: Visibility) {
  updateDoc(doc(db, "boxes", boxId, "recipes", recipeId), { visibility })
}

export async function setCookingModeSeen(userId: UserId) {
  updateDoc(doc(db, "users", userId), { cookingModeSeen: true })
}

export async function setLastSeenUpdateVersion(userId: UserId, version: number) {
  updateDoc(doc(db, "users", userId), { lastSeenUpdateVersion: version })
}

export async function applyEnrichment(
  boxId: BoxId,
  recipeId: RecipeId,
  enrichment: { description: string; suggestedTags: string[] }
) {
  const recipeRef = doc(db, "boxes", boxId, "recipes", recipeId);
  const recipeDoc = await getDoc(recipeRef);

  if (!recipeDoc.exists()) {
    console.warn("Recipe not found");
    return;
  }

  const recipeData = recipeDoc.data();
  const currentDescription = recipeData.data?.description;
  const currentTags = recipeData.data?.recipeCategory || [];

  // Merge suggested tags with existing tags (avoid duplicates, all lowercase)
  const existingTags = Array.isArray(currentTags) ? currentTags : [currentTags].filter(Boolean);
  const mergedTags = [...new Set([...existingTags, ...enrichment.suggestedTags].map(t => t.toLowerCase()))];

  const updates: Record<string, unknown> = {
    pendingEnrichment: deleteField(),
    enrichmentStatus: EnrichmentStatus.done,
  };

  // Only update description if there wasn't one
  if (!currentDescription?.trim()) {
    updates["data.description"] = enrichment.description;
  }

  // Update tags with merged list
  updates["data.recipeCategory"] = mergedTags;

  await updateDoc(recipeRef, updates);
}

export async function rejectEnrichment(boxId: BoxId, recipeId: RecipeId) {
  const recipeRef = doc(db, "boxes", boxId, "recipes", recipeId);
  await updateDoc(recipeRef, {
    pendingEnrichment: deleteField(),
    enrichmentStatus: EnrichmentStatus.skipped,
  });
}

export async function addCookingLogEntry(
  boxId: BoxId,
  recipeId: RecipeId,
  userId: string,
  note?: string
) {
  const recipeRef = doc(db, "boxes", boxId, "recipes", recipeId);
  const entry = {
    madeAt: Timestamp.now(),
    madeBy: userId,
    note: note || undefined,
  };
  await updateDoc(recipeRef, {
    cookingLog: arrayUnion(entry),
  });
}

export async function updateCookingLogEntry(
  boxId: BoxId,
  recipeId: RecipeId,
  entryIndex: number,
  note: string
) {
  const recipeRef = doc(db, "boxes", boxId, "recipes", recipeId);
  const recipeDoc = await getDoc(recipeRef);

  if (!recipeDoc.exists()) {
    console.warn("Recipe not found");
    return;
  }

  const data = recipeDoc.data();
  const cookingLog = [...(data.cookingLog || [])];

  if (entryIndex < 0 || entryIndex >= cookingLog.length) {
    console.warn("Invalid entry index");
    return;
  }

  cookingLog[entryIndex] = {
    ...cookingLog[entryIndex],
    note: note.trim() || undefined,
  };

  await updateDoc(recipeRef, { cookingLog });
}

export async function deleteCookingLogEntry(
  boxId: BoxId,
  recipeId: RecipeId,
  entryIndex: number
) {
  const recipeRef = doc(db, "boxes", boxId, "recipes", recipeId);
  const recipeDoc = await getDoc(recipeRef);

  if (!recipeDoc.exists()) {
    console.warn("Recipe not found");
    return;
  }

  const data = recipeDoc.data();
  const cookingLog = [...(data.cookingLog || [])];

  if (entryIndex < 0 || entryIndex >= cookingLog.length) {
    console.warn("Invalid entry index");
    return;
  }

  cookingLog.splice(entryIndex, 1);

  await updateDoc(recipeRef, { cookingLog });
}
