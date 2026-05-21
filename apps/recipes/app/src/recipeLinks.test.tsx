import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { parseRecipeLinks, LinkedText, makeStateResolver, type RecipeLinkResolver } from './recipeLinks';
import type { AppState } from './types';
import { EnrichmentStatus, Visibility } from './types';
import type { PlainBox, PlainRecipe } from './storage';

function makeRecipe(id: string, name: string): PlainRecipe {
  return {
    id,
    data: { '@type': 'Recipe', name },
    owners: [],
    editing: false,
    creator: 'u1',
    visibility: Visibility.private,
    created: new Date(),
    updated: new Date(),
    lastUpdatedBy: 'u1',
    enrichmentStatus: EnrichmentStatus.done,
  } as PlainRecipe;
}

function makeBox(id: string, recipes: PlainRecipe[]): PlainBox {
  return {
    id,
    data: { name: `box-${id}` },
    owners: [],
    subscribers: [],
    creator: 'u1',
    visibility: Visibility.private,
    recipes: new Map(recipes.map(r => [r.id, r])),
    created: new Date(),
    updated: new Date(),
    lastUpdatedBy: 'u1',
  };
}

function withRouter(node: ReactElement) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

describe('parseRecipeLinks', () => {
  const noResolver: RecipeLinkResolver = () => undefined;

  it('returns empty array for empty input', () => {
    expect(parseRecipeLinks('', noResolver, '')).toEqual([]);
  });

  it('passes through plain text unchanged (modulo HTML decode)', () => {
    const out = parseRecipeLinks('1 cup flour &amp; salt', noResolver, '');
    expect(out).toEqual(['1 cup flour & salt']);
  });

  it('splits a string containing a marker into [text, link, text]', () => {
    const out = parseRecipeLinks('Roll out the [[recipe:abc|pie dough]] and place in pan.', noResolver, '');
    // First and last are plain strings, middle is a React element.
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('Roll out the ');
    expect(out[2]).toBe(' and place in pan.');
  });

  it('handles multiple markers in one string', () => {
    const out = parseRecipeLinks('[[recipe:a|A]] then [[recipe:b|B]]', noResolver, '');
    // [link, " then ", link]
    expect(out).toHaveLength(3);
    expect(out[1]).toBe(' then ');
  });

  it('handles a bare marker (no label)', () => {
    const out = parseRecipeLinks('See [[recipe:xyz]]', noResolver, '');
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('See ');
  });

  it('is stateless across calls (regex.lastIndex reset)', () => {
    const first = parseRecipeLinks('[[recipe:a|A]]', noResolver, '');
    const second = parseRecipeLinks('[[recipe:b|B]]', noResolver, '');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});

describe('LinkedText rendering', () => {
  it('renders a resolved marker as a router Link with the label', () => {
    const pie = makeRecipe('pie1', 'Pie Dough');
    const resolver: RecipeLinkResolver = (id) => id === 'pie1' ? { boxId: 'box1', recipe: pie } : undefined;
    render(withRouter(<LinkedText text="Use [[recipe:pie1|the dough]] now" resolver={resolver} basePath="/recipes" />));
    const link = screen.getByRole('link', { name: 'the dough' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/recipes/boxes/box1/recipes/pie1');
  });

  it('falls back to the referenced recipe name when label is omitted', () => {
    const pie = makeRecipe('pie1', 'Pie Dough');
    const resolver: RecipeLinkResolver = () => ({ boxId: 'box1', recipe: pie });
    render(withRouter(<LinkedText text="Mix [[recipe:pie1]]." resolver={resolver} basePath="" />));
    expect(screen.getByRole('link', { name: 'Pie Dough' })).toBeInTheDocument();
  });

  it('degrades to the label when the recipe is unresolved', () => {
    const resolver: RecipeLinkResolver = () => undefined;
    render(withRouter(<LinkedText text="Use [[recipe:gone|Pie Dough]]" resolver={resolver} basePath="" />));
    // No link rendered; label still visible.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Pie Dough')).toBeInTheDocument();
  });

  it('degrades to "[unknown recipe]" when both unresolved and unlabeled', () => {
    render(withRouter(<LinkedText text="See [[recipe:gone]]" basePath="" />));
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('[unknown recipe]')).toBeInTheDocument();
  });

  it('never leaks raw markup to the DOM', () => {
    const { container } = render(withRouter(<LinkedText text="A [[recipe:x|y]] B" basePath="" />));
    expect(container.textContent).not.toContain('[[');
    expect(container.textContent).not.toContain(']]');
  });

  it('renders nothing-special when there are no markers', () => {
    const { container } = render(withRouter(<LinkedText text="just text" basePath="" />));
    expect(container.textContent).toBe('just text');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('makeStateResolver', () => {
  it('finds a recipe across boxes', () => {
    const r = makeRecipe('r1', 'Cake');
    const state: AppState = {
      boxes: new Map([
        ['boxA', makeBox('boxA', [])],
        ['boxB', makeBox('boxB', [r])],
      ]),
      users: new Map(),
      writeable: true,
      loading: 0,
      subscriptionsReady: true,
    };
    const resolver = makeStateResolver(state);
    const hit = resolver('r1');
    expect(hit).toBeDefined();
    expect(hit!.boxId).toBe('boxB');
    expect(hit!.recipe).toBe(r);
  });

  it('returns undefined when no box contains the recipe', () => {
    const state: AppState = {
      boxes: new Map([['boxA', makeBox('boxA', [makeRecipe('other', 'Other')])]]),
      users: new Map(),
      writeable: true,
      loading: 0,
      subscriptionsReady: true,
    };
    const resolver = makeStateResolver(state);
    expect(resolver('missing')).toBeUndefined();
  });

  it('returns the first match if a recipe id were somehow in multiple boxes', () => {
    // (Not a real-world state — recipes don't normally exist in two boxes —
    // but document the behaviour so a future migration bug doesn't silently
    // pick the "wrong" one.)
    const r = makeRecipe('r1', 'Cake');
    const state: AppState = {
      boxes: new Map([
        ['boxA', makeBox('boxA', [r])],
        ['boxB', makeBox('boxB', [r])],
      ]),
      users: new Map(),
      writeable: true,
      loading: 0,
      subscriptionsReady: true,
    };
    expect(makeStateResolver(state)('r1')!.boxId).toBe('boxA');
  });
});

// Silence the unused-import warning if vi is not actually used by any test.
void vi;
