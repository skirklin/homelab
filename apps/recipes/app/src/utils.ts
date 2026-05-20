import { getBackend } from '@kirkl/shared';
import type { Recipe } from "schema-dts"
import { type PlainBox, type PlainRecipe, type PlainUser } from './storage';
import { EnrichmentStatus, Visibility } from './types';

export function createNewRecipe(user: PlainUser): PlainRecipe {
  const owners = [user.id];
  const data: Recipe = {
    "@type": "Recipe",
    "name": "New recipe",
    "recipeInstructions": [],
    "recipeIngredient": [],
    "description": "",
  }
  return {
    id: "placeholder",
    data,
    owners,
    editing: false,
    creator: user.id,
    visibility: Visibility.private,
    created: new Date(),
    updated: new Date(),
    lastUpdatedBy: user.id,
    enrichmentStatus: EnrichmentStatus.needed,
  };
}


export function createNewBox(user: PlainUser): PlainBox {
  const name = "New box"
  return {
    id: "placeholder",
    data: { name },
    owners: [user.id],
    subscribers: [],
    creator: user.id,
    visibility: Visibility.private,
    recipes: new Map(),
    created: new Date(),
    updated: new Date(),
    lastUpdatedBy: user.id,
  };
}

const objIdMap = new WeakMap<object, number>();
let objectCount = 0;
export function getUniqueId(rcp: PlainRecipe) {
  if (!objIdMap.has(rcp)) objIdMap.set(rcp, ++objectCount);
  return objIdMap.get(rcp);
}

export function download(recipe: PlainRecipe) {
  const downloadLink = document.createElement("a");
  downloadLink.download = (recipe.data.name as string) + ".json"
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

export function userSignOut() {
  getBackend().authStore.clear();
}

export function canUpdateRecipe(recipe: PlainRecipe | undefined, box: PlainBox | undefined, user: PlainUser | undefined) {
  if (user === undefined || recipe === undefined || box === undefined) return false
  const owner = recipe.owners.includes(user.id) || box.owners.includes(user.id)
  return owner
}
