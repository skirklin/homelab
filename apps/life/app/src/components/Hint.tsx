/**
 * Small secondary text primitive — local to the life app.
 *
 * Default: small/secondary (matches the dashboard session hints).
 * `$muted`: extra-small/muted (for de-emphasized inline annotations).
 *
 * Positional concerns (margins, font-weight tweaks) live at the callsite as
 * inline styles rather than as props on this primitive.
 */
import styled from "styled-components";

export const Hint = styled.span<{ $muted?: boolean }>`
  font-size: ${(p) => (p.$muted ? "var(--font-size-xs)" : "var(--font-size-sm)")};
  color: ${(p) => (p.$muted ? "var(--color-text-muted)" : "var(--color-text-secondary)")};
`;
