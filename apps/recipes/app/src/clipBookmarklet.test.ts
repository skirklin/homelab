import { describe, expect, it } from 'vitest';

import { CLIP_BOOKMARKLET, CLIP_IMPORT_URL } from './clipBookmarklet';

/** Extract the function body from `javascript:(function(){...})();`. */
function bookmarkletBody(): string {
  const prefix = 'javascript:';
  expect(CLIP_BOOKMARKLET.startsWith(prefix)).toBe(true);
  const after = CLIP_BOOKMARKLET.slice(prefix.length);
  const m = after.match(/^\(function\(\)\{([\s\S]*)\}\)\(\);$/);
  expect(m).not.toBeNull();
  return m![1];
}

describe('clip bookmarklet', () => {
  it('points at the /import page', () => {
    expect(CLIP_IMPORT_URL).toMatch(/\/import$/);
  });

  it('parses as valid JS via new Function (top-level return is legal in a function body)', () => {
    const body = bookmarkletBody();
    // new Function wraps the body in a fresh function scope, so the
    // top-level early returns in the source are valid here.
    expect(() => new Function(body)).not.toThrow();
  });

  it('strips review/aggregateRating/comment/commentCount (ImportModal parity)', () => {
    const body = bookmarkletBody();
    for (const field of ['review', 'aggregateRating', 'comment', 'commentCount']) {
      expect(body).toContain(`delete it.${field}`);
    }
  });

  it('guards against an over-long URL instead of opening a doomed one', () => {
    const body = bookmarkletBody();
    expect(body).toContain('30000');
    // The length check must precede window.open so the doomed open is skipped.
    expect(body.indexOf('30000')).toBeLessThan(body.indexOf('window.open'));
  });
});
