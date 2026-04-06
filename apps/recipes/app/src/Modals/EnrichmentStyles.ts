import styled from 'styled-components';

export const Section = styled.div`
  margin: var(--space-xs) 0;
`

export const SectionLabel = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  font-weight: 500;
`

export const SuggestedDescription = styled.p`
  font-style: italic;
  color: var(--color-text);
  margin: var(--space-xs) 0;
  padding-left: var(--space-sm);
  border-left: 2px solid var(--color-border);
`

export const TagsContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-top: var(--space-xs);
`

export const Reasoning = styled.p`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin: var(--space-xs) 0 0 0;
`
