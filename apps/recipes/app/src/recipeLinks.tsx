/**
 * Inline cross-recipe link markup.
 *
 * Free-form text fields on a recipe (ingredient lines, step text, description,
 * notes) may contain `[[recipe:<id>|optional label]]` markers that the
 * renderer turns into in-app links to the referenced recipe.
 *
 * Storage format:
 *   - With label:   `[[recipe:abc123|Pie Dough]]`
 *   - Bare:         `[[recipe:abc123]]`    — renderer resolves the name on the fly
 *
 * The markup lives inside the existing string fields — no schema change. The
 * canonical recipe `name` field deliberately doesn't render markup (a title
 * shouldn't depend on another recipe's existence).
 *
 * Resolution is delegated to a `resolver` so callers can supply either the
 * in-memory `AppState.boxes` map (authenticated view) or a no-op (public
 * recipe view, where we only have the current box loaded). Unresolved links
 * degrade to the label, or to "[unknown recipe]" if none was provided.
 */
import type React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";
import type { AppState, BoxId, RecipeId } from "./types";
import { getRecipeName, type PlainRecipe } from "./storage";
import { decodeStr } from "./converters";

/**
 * Matches `[[recipe:<id>]]` or `[[recipe:<id>|label]]`.
 *
 * - `<id>` is one or more characters that aren't `|` or `]`, so the marker is
 *   resilient to whatever shape backend IDs take (PB uses 15-char alphanumeric,
 *   Supabase uses UUIDs).
 * - `<label>` is one or more characters that aren't `]`, allowing labels with
 *   spaces, punctuation, etc.
 *
 * Global+sticky so we can drive a `while (exec)` loop in {@link parseRecipeLinks}.
 */
export const RECIPE_LINK_RE = /\[\[recipe:([^|\]]+)(?:\|([^\]]+))?\]\]/g;

export interface RecipeLinkResolution {
  boxId: BoxId;
  recipe: PlainRecipe;
}

export type RecipeLinkResolver = (recipeId: RecipeId) => RecipeLinkResolution | undefined;

/**
 * Build a resolver backed by the live `state.boxes` Map. Returns the first
 * box that contains the recipe — recipes don't naturally exist in multiple
 * boxes, so the scan is unambiguous in practice.
 *
 * Box-scoped scans are O(boxes × recipes-per-box). For personal-use scale
 * (tens of boxes, hundreds of recipes) this is well under a millisecond and
 * not worth caching.
 */
export function makeStateResolver(state: AppState): RecipeLinkResolver {
  return (recipeId) => {
    for (const [boxId, box] of state.boxes) {
      const recipe = box.recipes.get(recipeId);
      if (recipe) return { boxId, recipe };
    }
    return undefined;
  };
}

const StyledRecipeLink = styled(Link)`
  color: var(--color-primary);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;

  &:hover {
    text-decoration-style: solid;
  }
`;

const UnresolvedRecipeLink = styled.span`
  color: var(--color-text-muted);
  font-style: italic;
  text-decoration: line-through;
`;

interface LinkedTextProps {
  /** Source string, possibly containing `[[recipe:...]]` markers */
  text: string | undefined | null;
  /** Resolve a recipe id to its box+recipe so we can build a route */
  resolver?: RecipeLinkResolver;
  /** Base path prefix for the Link href (matches `useBasePath()` from RecipesRoutes) */
  basePath?: string;
}

/**
 * Render text with `[[recipe:...]]` markers replaced by in-app links. Plain
 * runs are HTML-entity-decoded the same way `decodeStr` did for the raw
 * string, so this is a drop-in replacement for `decodeStr(String(x))` at
 * existing render sites.
 */
export function LinkedText({ text, resolver, basePath = "" }: LinkedTextProps): React.ReactElement {
  const parts = parseRecipeLinks(text ?? "", resolver, basePath);
  // Wrap in a fragment so callers can drop this directly into a list item / paragraph.
  return <>{parts}</>;
}

/**
 * Parse a string into a mixed array of decoded plain-text runs and link elements.
 * Exported so non-React consumers (e.g. tests, future search highlighters) can
 * tokenize the same way.
 */
export function parseRecipeLinks(
  text: string,
  resolver: RecipeLinkResolver | undefined,
  basePath: string,
): React.ReactNode[] {
  if (!text) return [];

  // Reset the regex's lastIndex — RECIPE_LINK_RE is a module-level global regex,
  // and global regexes carry state across calls.
  RECIPE_LINK_RE.lastIndex = 0;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = RECIPE_LINK_RE.exec(text)) !== null) {
    if (match.index > cursor) {
      const plain = text.slice(cursor, match.index);
      nodes.push(decodeStr(plain) ?? plain);
    }
    const [, recipeId, label] = match;
    nodes.push(renderRecipeLink(recipeId, label, resolver, basePath, key++));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    const plain = text.slice(cursor);
    nodes.push(decodeStr(plain) ?? plain);
  }
  return nodes;
}

function renderRecipeLink(
  recipeId: string,
  label: string | undefined,
  resolver: RecipeLinkResolver | undefined,
  basePath: string,
  key: number,
): React.ReactElement {
  const resolved = resolver?.(recipeId);
  if (resolved) {
    const display = decodeStr(label) ?? getRecipeName(resolved.recipe) ?? "Untitled recipe";
    const href = `${basePath}/boxes/${resolved.boxId}/recipes/${recipeId}`;
    return (
      <StyledRecipeLink key={key} to={href}>
        {display}
      </StyledRecipeLink>
    );
  }
  // Unresolved: render the label if we have one (so the reader still gets a
  // hint), otherwise a generic placeholder. Never leak the raw `[[...]]`.
  const fallback = decodeStr(label) ?? "[unknown recipe]";
  return (
    <UnresolvedRecipeLink key={key} title="Recipe not available">
      {fallback}
    </UnresolvedRecipeLink>
  );
}
