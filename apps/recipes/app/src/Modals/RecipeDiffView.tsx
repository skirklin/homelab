import styled from 'styled-components';

type DiffLineType = 'same' | 'added' | 'removed';

interface DiffLine {
  type: DiffLineType;
  value: string;
}

interface RecipeDiffViewProps {
  original: {
    ingredients: string[];
    instructions: string[];
  };
  modified: {
    ingredients: string[];
    instructions: string[];
  };
  reasoning?: string;
  compact?: boolean;
}

const DiffContainer = styled.div`
  background: var(--color-bg-muted);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-md);
`;

const DiffSection = styled.div`
  margin-bottom: var(--space-md);

  &:last-child {
    margin-bottom: 0;
  }
`;

const SectionTitle = styled.div`
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-sm);
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const DiffLine = styled.div<{ $type: DiffLineType }>`
  padding: var(--space-xs) var(--space-sm);
  font-size: var(--font-size-sm);
  border-radius: var(--radius-sm);
  margin-bottom: 2px;

  ${({ $type }) => {
    switch ($type) {
      case 'added':
        return `
          background: rgba(82, 196, 26, 0.15);
          color: #52c41a;
          &::before {
            content: '+ ';
            font-weight: bold;
          }
        `;
      case 'removed':
        return `
          background: rgba(255, 77, 79, 0.15);
          color: #ff4d4f;
          text-decoration: line-through;
          &::before {
            content: '- ';
            font-weight: bold;
          }
        `;
      default:
        return `
          color: var(--color-text);
          &::before {
            content: '  ';
          }
        `;
    }
  }}
`;

const Reasoning = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  font-style: italic;
  padding: var(--space-sm);
  background: rgba(147, 112, 219, 0.1);
  border-radius: var(--radius-sm);
  border-left: 3px solid #9370db;
`;

/**
 * Compute a simple diff between two string arrays.
 * Uses set comparison for ingredients (order doesn't matter)
 * and index-based comparison for instructions (order matters).
 */
function computeIngredientDiff(original: string[], modified: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const normalize = (s: string) => s.toLowerCase().trim();

  const originalNormalized = new Map(original.map(o => [normalize(o), o]));
  const modifiedNormalized = new Map(modified.map(m => [normalize(m), m]));

  // Find removed items (in original but not in modified)
  for (const [normalizedKey, originalValue] of originalNormalized) {
    if (!modifiedNormalized.has(normalizedKey)) {
      result.push({ type: 'removed', value: originalValue });
    }
  }

  // Add all modified items, marking new ones as added
  for (const [normalizedKey, modifiedValue] of modifiedNormalized) {
    if (originalNormalized.has(normalizedKey)) {
      result.push({ type: 'same', value: modifiedValue });
    } else {
      result.push({ type: 'added', value: modifiedValue });
    }
  }

  return result;
}

function computeInstructionDiff(original: string[], modified: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const maxLen = Math.max(original.length, modified.length);

  for (let i = 0; i < maxLen; i++) {
    const orig = original[i];
    const mod = modified[i];

    if (orig && mod) {
      // Both exist at this index
      if (orig.toLowerCase().trim() === mod.toLowerCase().trim()) {
        result.push({ type: 'same', value: mod });
      } else {
        // Changed - show removed then added
        result.push({ type: 'removed', value: orig });
        result.push({ type: 'added', value: mod });
      }
    } else if (orig && !mod) {
      // Removed
      result.push({ type: 'removed', value: orig });
    } else if (!orig && mod) {
      // Added
      result.push({ type: 'added', value: mod });
    }
  }

  return result;
}

export function RecipeDiffView({ original, modified, reasoning, compact = false }: RecipeDiffViewProps) {
  const ingredientDiff = computeIngredientDiff(original.ingredients, modified.ingredients);
  const instructionDiff = computeInstructionDiff(original.instructions, modified.instructions);

  // Check if there are any actual changes
  const hasIngredientChanges = ingredientDiff.some(d => d.type !== 'same');
  const hasInstructionChanges = instructionDiff.some(d => d.type !== 'same');

  // In compact mode, only show changed items
  const displayIngredients = compact
    ? ingredientDiff.filter(d => d.type !== 'same')
    : ingredientDiff;
  const displayInstructions = compact
    ? instructionDiff.filter(d => d.type !== 'same')
    : instructionDiff;

  return (
    <DiffContainer>
      {hasIngredientChanges && (
        <DiffSection>
          <SectionTitle>Ingredients</SectionTitle>
          {displayIngredients.map((line, idx) => (
            <DiffLine key={`ing-${idx}`} $type={line.type}>
              {line.value}
            </DiffLine>
          ))}
        </DiffSection>
      )}

      {hasInstructionChanges && (
        <DiffSection>
          <SectionTitle>Instructions</SectionTitle>
          {displayInstructions.map((line, idx) => (
            <DiffLine key={`inst-${idx}`} $type={line.type}>
              {line.value}
            </DiffLine>
          ))}
        </DiffSection>
      )}

      {!hasIngredientChanges && !hasInstructionChanges && (
        <DiffSection>
          <div style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
            No changes detected
          </div>
        </DiffSection>
      )}

      {reasoning && (
        <Reasoning>
          <strong>Changes: </strong>{reasoning}
        </Reasoning>
      )}
    </DiffContainer>
  );
}

export default RecipeDiffView;
