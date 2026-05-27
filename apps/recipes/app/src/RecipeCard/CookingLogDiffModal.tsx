/**
 * Modal that renders the diff between a cooking-log entry's recipe snapshot
 * and the live recipe. Used by the "What changed?" button per entry on the
 * recipe detail page. Solves the "did I incorporate my note?" problem —
 * user leaves "too dry, add another cup of milk", later wants to know if the
 * recipe reflects it.
 *
 * Owns just the presentation. Diff computation lives in recipeDiff.ts; this
 * file is the AntD shell that turns sections into styled rows.
 */

import { Modal } from "antd";
import styled from "styled-components";
import type { RecipeLike, RecipeDiff, IngredientChange, StepChange, FieldChange } from "./recipeDiff";
import { diffRecipes } from "./recipeDiff";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Recipe.data captured at cook time. Undefined → snapshot predates the feature. */
  snapshot: RecipeLike | undefined;
  /** Current live recipe.data. */
  current: RecipeLike | undefined;
  /** Display date of the cook session (already-formatted). */
  cookedOnLabel: string;
}

const Section = styled.section`
  margin-top: var(--space-md);
  &:first-child {
    margin-top: 0;
  }
`;

const SectionTitle = styled.h4`
  margin: 0 0 var(--space-sm) 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-primary);
`;

const ChangeList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

const ChangeRow = styled.li<{ $kind: "added" | "removed" | "changed" }>`
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-sm);
  font-family: var(--font-family-mono, monospace);
  font-size: var(--font-size-sm);
  line-height: 1.4;
  background: ${(p) =>
    p.$kind === "added"
      ? "rgba(34, 197, 94, 0.08)"
      : p.$kind === "removed"
      ? "rgba(239, 68, 68, 0.08)"
      : "rgba(234, 179, 8, 0.08)"};
  color: var(--color-text);
  word-break: break-word;
`;

const Marker = styled.span<{ $kind: "added" | "removed" | "changed" }>`
  display: inline-block;
  width: 1em;
  color: ${(p) =>
    p.$kind === "added"
      ? "rgb(34, 197, 94)"
      : p.$kind === "removed"
      ? "rgb(239, 68, 68)"
      : "rgb(202, 138, 4)"};
  font-weight: 700;
`;

const Old = styled.span`
  color: var(--color-text-secondary);
  text-decoration: line-through;
`;

const Arrow = styled.span`
  color: var(--color-text-secondary);
  margin: 0 0.5em;
`;

const StepBlock = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

const StepLabel = styled.div`
  font-family: var(--font-family-base, sans-serif);
  font-weight: 600;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

const StepText = styled.div`
  white-space: pre-wrap;
`;

const Empty = styled.p`
  color: var(--color-text-muted);
  font-style: italic;
  text-align: center;
  margin: var(--space-lg) 0;
`;

const CookedLabel = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-md);
`;

// Renderers ----------------------------------------------------------------

function MARKER(kind: "added" | "removed" | "changed"): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "−";
  return "~";
}

function IngredientLine({ change }: { change: IngredientChange }) {
  if (change.kind === "added") {
    return (
      <ChangeRow $kind="added">
        <Marker $kind="added">{MARKER("added")} </Marker>
        {change.after}
      </ChangeRow>
    );
  }
  if (change.kind === "removed") {
    return (
      <ChangeRow $kind="removed">
        <Marker $kind="removed">{MARKER("removed")} </Marker>
        <Old>{change.before}</Old>
      </ChangeRow>
    );
  }
  return (
    <ChangeRow $kind="changed">
      <Marker $kind="changed">{MARKER("changed")} </Marker>
      <Old>{change.before}</Old>
      <Arrow>→</Arrow>
      <span>{change.after}</span>
    </ChangeRow>
  );
}

function StepLine({ change }: { change: StepChange }) {
  if (change.kind === "added") {
    return (
      <ChangeRow $kind="added">
        <StepBlock>
          <StepLabel>+ Added step {change.index}</StepLabel>
          <StepText>{change.after}</StepText>
        </StepBlock>
      </ChangeRow>
    );
  }
  if (change.kind === "removed") {
    return (
      <ChangeRow $kind="removed">
        <StepBlock>
          <StepLabel>− Removed step {change.index}</StepLabel>
          <StepText><Old>{change.before}</Old></StepText>
        </StepBlock>
      </ChangeRow>
    );
  }
  return (
    <ChangeRow $kind="changed">
      <StepBlock>
        <StepLabel>~ Step {change.index}</StepLabel>
        <StepText><Old>{change.before}</Old></StepText>
        <StepText>{change.after}</StepText>
      </StepBlock>
    </ChangeRow>
  );
}

/** Translate camelCase field name to a friendly label. */
function fieldLabel(field: string): string {
  switch (field) {
    case "name": return "Name";
    case "description": return "Description";
    case "recipeYield": return "Yield";
    case "recipeCuisine": return "Cuisine";
    case "prepTime": return "Prep time";
    case "cookTime": return "Cook time";
    case "totalTime": return "Total time";
    case "url": return "Source URL";
    default: return field;
  }
}

function FieldLine({ change }: { change: FieldChange }) {
  const kind: "added" | "removed" | "changed" =
    change.before === undefined ? "added" : change.after === undefined ? "removed" : "changed";
  return (
    <ChangeRow $kind={kind}>
      <Marker $kind={kind}>{MARKER(kind)} </Marker>
      <strong>{fieldLabel(change.field)}:</strong>{" "}
      {change.before !== undefined && <Old>{change.before}</Old>}
      {change.before !== undefined && change.after !== undefined && <Arrow>→</Arrow>}
      {change.after !== undefined && <span>{change.after}</span>}
    </ChangeRow>
  );
}

// Top-level modal ----------------------------------------------------------

export function CookingLogDiffModal(props: Props) {
  const { open, onClose, snapshot, current, cookedOnLabel } = props;

  // Compute diff only when open — the diff is cheap, but this also keeps the
  // closed modal from re-running on every parent rerender.
  const diff: RecipeDiff | null = open ? diffRecipes(snapshot, current) : null;

  return (
    <Modal
      title="What changed since you cooked this?"
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnClose
    >
      <CookedLabel>Compared to the recipe as of {cookedOnLabel}.</CookedLabel>
      {!diff ? null : diff.isEmpty ? (
        <Empty>No changes since this cook.</Empty>
      ) : (
        <>
          {diff.fields.length > 0 && (
            <Section>
              <SectionTitle>Recipe info</SectionTitle>
              <ChangeList>
                {diff.fields.map((c) => (
                  <FieldLine key={c.field} change={c} />
                ))}
              </ChangeList>
            </Section>
          )}
          {diff.ingredients.length > 0 && (
            <Section>
              <SectionTitle>Ingredients</SectionTitle>
              <ChangeList>
                {diff.ingredients.map((c, i) => (
                  <IngredientLine key={`${c.name}-${i}`} change={c} />
                ))}
              </ChangeList>
            </Section>
          )}
          {diff.steps.length > 0 && (
            <Section>
              <SectionTitle>Steps</SectionTitle>
              <ChangeList>
                {diff.steps.map((c) => (
                  <StepLine key={`${c.kind}-${c.index}`} change={c} />
                ))}
              </ChangeList>
            </Section>
          )}
        </>
      )}
    </Modal>
  );
}

export default CookingLogDiffModal;
