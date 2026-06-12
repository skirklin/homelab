/**
 * Unit tests for the GET /oauth/authorize login page HTML.
 *
 * Regression test for a live bug: a JS comment inside the inline Google
 * sign-in <script> contained the literal text "</script>". The browser's
 * HTML parser terminates a script element at the FIRST "</script" sequence
 * regardless of JS string/comment context, so the script was truncated to a
 * syntax error (dead Google button) and the remainder rendered as page text.
 *
 * The test emulates the browser's script-data parsing: each inline script
 * body runs from the end of its open tag to the first "</script" after it.
 * It then asserts (a) open/close script tags balance, (b) every inline body
 * is syntactically valid JS, (c) no body contains "<!--" (which shifts the
 * HTML parser into escaped-script-data mode with its own footguns).
 */
import { describe, it, expect } from "vitest";
import { renderLoginPage } from "./oauth";

/** Browser-style extraction: script data ends at the first "</script". */
function extractInlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const openRe = /<script\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    // External scripts (src=...) have empty bodies; still parse them the same way.
    const bodyStart = m.index + m[0].length;
    const close = html.toLowerCase().indexOf("</script", bodyStart);
    expect(close, "script element never closed").toBeGreaterThan(-1);
    bodies.push(html.slice(bodyStart, close));
    openRe.lastIndex = close;
  }
  return bodies;
}

function countMatches(html: string, re: RegExp): number {
  return (html.match(re) ?? []).length;
}

function assertWellFormedScripts(html: string) {
  // One close per open. The truncation bug shows up as an extra "</script"
  // (the one inside the JS comment) that the browser treats as a real close.
  expect(countMatches(html, /<script\b/gi)).toBe(countMatches(html, /<\/script/gi));

  for (const body of extractInlineScriptBodies(html)) {
    expect(body).not.toMatch(/<\/script/i);
    expect(body).not.toContain("<!--");
    // The body as the browser sees it must be valid JS (compile, don't run).
    expect(() => new Function(body), `inline script is not valid JS:\n${body}`).not.toThrow();
  }
}

describe("oauth login page HTML", () => {
  it("serves well-formed inline scripts", () => {
    const html = renderLoginPage("Claude", "", "https://api.kirkl.in", "kirkl.in");
    assertWellFormedScripts(html);
  });

  it("stays well-formed for a hostile pbUrl containing a closing script tag", () => {
    const html = renderLoginPage("Claude", "", 'https://evil</script><script>alert(1)</script>', "kirkl.in");
    assertWellFormedScripts(html);
  });

  it("links to signup in a new tab so the in-progress OAuth flow isn't lost", () => {
    const html = renderLoginPage("Claude", "", "https://api.kirkl.in", "kirkl.in");
    expect(html).toContain(
      '<a href="https://kirkl.in" target="_blank" rel="noopener">Sign up at kirkl.in</a>',
    );
    expect(html).toContain("No account yet?");
    expect(html).toContain("then come back here and sign in");
  });

  it("HTML-escapes a hostile domain and stays well-formed", () => {
    const hostile = 'evil"><script>alert(1)</script>';
    const html = renderLoginPage("Claude", "", "https://api.kirkl.in", hostile);
    assertWellFormedScripts(html);
    expect(html).not.toContain('href="https://evil"><script>');
  });
});
