import _ from 'lodash';
import { Comment, Recipe } from "schema-dts"

/* helper functions for converting between structured data and text. */
export function strToIngredients(str: string): Recipe["recipeIngredient"] {
  /* convert text with one ingredient per line to a list of ingredients.

  ingredient blah blah
  ingredient 2 blah blah blah

   ->

  ["ingredient blah blah", "ingredient 2 blah blah blah"]
  */
  const lines = str.split("\n")
  return lines
}


export function strToInstructions(str: string): Recipe["recipeInstructions"] {
  /* convert text with one ingredient per line to a list of ingredients.

  step 1 blah blah
  step 2 blah blah blah

   ->

  [
      {"@type": "HowToStep", "text": "ingredient blah blah"},
      {"@type": "HowToStep", "text": "ingredient 2 blah blah blah"}
  ]
  */
  const lines = _.filter(str.trim().split("\n"))
  return lines.map(s => ({ "@type": "HowToStep", text: s }))
}

export function instructionsToStr(instructions: Recipe["recipeInstructions"]): string {
  if (instructions === undefined) {
    return ""
  }
  if (typeof instructions === "string") {
    return instructions.toString()
  }
  const instructionArray = Array.isArray(instructions) ? instructions : [];
  const steps = instructionArray.map((x: unknown) => {
    if (typeof x === 'object' && x !== null && 'text' in x) {
      return String((x as { text: unknown }).text).trim();
    }
    return "";
  });
  return steps.join("\n\n")
}

export function ingredientsToStr(ingredients: Recipe["recipeIngredient"]): string {
  const ingredientArray = Array.isArray(ingredients) ? ingredients : [];
  const steps = ingredientArray.map((x: unknown) => String(x));
  return steps.join("\n")
}

export function authorToStr(author: Recipe["author"]): string | undefined {
  if (author === undefined) {
    return undefined
  } else if (typeof author === "object") {
    if (Object.prototype.hasOwnProperty.call(author, "name")) {
      // this is hacky, but typescript was making this brutally unpleasant and I didn't want to spend more time on it.
      return (author as { name: string }).name
    } else {
      const authorArray = Array.isArray(author) ? author : [];
      const names = authorArray.map(
        (x: unknown) => {
          if (typeof x === 'object' && x !== null && '@type' in x && (x as Record<string, unknown>)['@type'] === "Person") {
            return String((x as Record<string, unknown>)['name'] || "")
          } else {
            return ""
          }
        })
      const nonEmptyNames = _.filter(names, (x: string) => x.length > 0)
      return nonEmptyNames.join(", ")
    }
  }
  return undefined
}


export function strToAuthor(author: string): Recipe["author"] {
  return { "@type": "Person", name: author }
}


export function commentToStr(comment: Recipe["comment"]): string | undefined {
  if (comment === undefined) {
    return undefined
  } else if (typeof comment === "object") {
    if (Object.prototype.hasOwnProperty.call(comment, "text")) {
      return decodeStr((comment as { text: string }).text)
    } else {
      console.warn("Unfamiliar comment format:", comment)
    }
  }
  return undefined
}


export function strToComment(text: string): Comment {
  return { "@type": "Comment", text }
}

export function parseCategories(categories: Recipe["recipeCategory"]): string[] {
  if (categories === undefined) {
    return []
  } else if (typeof categories === "string") {
    return [decodeStr(categories) || categories]
  } else {
    return Array.isArray(categories) ? categories.map(c => decodeStr(String(c)) || String(c)) : [];
  }
}

export function formatCategories(tags: string[]): Recipe["recipeCategory"] {
  return tags.map(t => t.toLowerCase())
}

export function decodeStr(s: string | undefined): string | undefined {
  if (s === undefined) {
    return undefined
  }
  // Use the browser's built-in HTML decoder to handle all entities
  // (&#x27;, &#39;, &amp;, &quot;, etc.)
  const textarea = document.createElement('textarea');
  textarea.innerHTML = s;
  return textarea.value;
}
