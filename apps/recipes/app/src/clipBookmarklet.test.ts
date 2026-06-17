import { describe, expect, it } from 'vitest';

import { buildClipBookmarklet } from './clipBookmarklet';

/** Extract the function body from `javascript:(function(){...})();`. */
function bookmarkletBody(bookmarklet: string): string {
  const prefix = 'javascript:';
  expect(bookmarklet.startsWith(prefix)).toBe(true);
  const after = bookmarklet.slice(prefix.length);
  const m = after.match(/^\(function\(\)\{([\s\S]*)\}\)\(\);$/);
  expect(m).not.toBeNull();
  return m![1];
}

describe('clip bookmarklet', () => {
  it('parses as valid JS via new Function (top-level return is legal in a function body)', () => {
    const body = bookmarkletBody(
      buildClipBookmarklet('https://kirkl.in/recipes/import'),
    );
    // new Function wraps the body in a fresh function scope, so the
    // top-level early returns in the source are valid here.
    expect(() => new Function(body)).not.toThrow();
  });

  it('targets the import URL passed in', () => {
    const body = bookmarkletBody(
      buildClipBookmarklet('https://kirkl.in/recipes/import'),
    );
    expect(body).toContain('https://kirkl.in/recipes/import');
  });

  it('reflects a different import URL (standalone origin)', () => {
    const body = bookmarkletBody(
      buildClipBookmarklet('https://recipes.kirkl.in/import'),
    );
    expect(body).toContain('https://recipes.kirkl.in/import');
    expect(body).not.toContain('https://kirkl.in/recipes/import');
  });

  it('strips review/aggregateRating/comment/commentCount (ImportModal parity)', () => {
    const body = bookmarkletBody(
      buildClipBookmarklet('https://kirkl.in/recipes/import'),
    );
    for (const field of ['review', 'aggregateRating', 'comment', 'commentCount']) {
      expect(body).toContain(`delete it.${field}`);
    }
  });

  it('guards against an over-long URL instead of opening a doomed one', () => {
    const body = bookmarkletBody(
      buildClipBookmarklet('https://kirkl.in/recipes/import'),
    );
    expect(body).toContain('30000');
    // The length check must precede window.open so the doomed open is skipped.
    expect(body.indexOf('30000')).toBeLessThan(body.indexOf('window.open'));
  });
});
