import { getAuth, signOut } from 'firebase/auth';
import React from 'react';
import { Recipe } from "schema-dts"
import { BoxEntry, RecipeEntry, UserEntry } from './storage';
import { ActionType, Visibility } from './types';

export function createNewRecipe(user: UserEntry) {
  const owners = [user.id];
  const data: Recipe = {
    "@type": "Recipe",
    "name": "New recipe",
    "recipeInstructions": [],
    "recipeIngredient": [],
    "description": "",
  }
  return new RecipeEntry(
    data,
    owners,
    Visibility.private,
    user.id,
    "placeholder",
    new Date(),
    new Date(),
    user.id
  )
}


export function createNewBox(user: UserEntry) {
  const name = "New box"
  return new BoxEntry({ name }, [user.id], Visibility.private, user.id, "placeholder", new Date(), new Date(), user.id)
}

const objIdMap = new WeakMap();
let objectCount = 0;
export function getUniqueId(rcp: RecipeEntry) {
  if (!objIdMap.has(rcp)) objIdMap.set(rcp, ++objectCount);
  return objIdMap.get(rcp);
}

export function download(recipe: RecipeEntry) {
  const downloadLink = document.createElement("a");
  downloadLink.download = recipe.data.name + ".json"
  downloadLink.innerHTML = "Download File";

  // Create a "file" to download
  downloadLink.href = makeTextFile(JSON.stringify(recipe, null, 2))
  document.body.appendChild(downloadLink);

  // wait for the link to be added to the document
  window.requestAnimationFrame(function () {
    const event = new MouseEvent('click');
    downloadLink.dispatchEvent(event); // synthetically click on it
    document.body.removeChild(downloadLink);
  });
}


let textFile: string | null;

function makeTextFile(text: string) {
  const data = new Blob([text], { type: 'application/ld+json' });

  // If we are replacing a previously generated file we need to
  // manually revoke the object URL to avoid memory leaks.
  if (textFile !== null) {
    window.URL.revokeObjectURL(textFile);
  }

  textFile = window.URL.createObjectURL(data);

  // returns a URL you can use as a href
  return textFile;
}

export function userSignOut(dispatch: React.Dispatch<ActionType>) {
  signOut(getAuth());
  dispatch({ type: "SET_AUTH_USER", authUser: null })
}

export function canUpdateRecipe(recipe: RecipeEntry | undefined, box: BoxEntry | undefined, user: UserEntry | undefined) {
  if (user === undefined || recipe === undefined || box === undefined) return false
  const owner = recipe.owners.includes(user.id) || box.owners.includes(user.id)
  return owner
}
