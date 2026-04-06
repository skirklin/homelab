import styled from "styled-components";

// ============================================
// Page Layout
// ============================================

/**
 * Standard page container with max-width and centered content.
 * Use for main page content areas.
 */
export const PageContainer = styled.div<{ $maxWidth?: string }>`
  max-width: ${props => props.$maxWidth || "800px"};
  margin: 0 auto;
  padding: var(--space-sm);

  @media (min-width: 400px) {
    padding: var(--space-lg);
  }
`;

/**
 * Wide container for dashboards and list views.
 */
export const WideContainer = styled(PageContainer)`
  max-width: 1200px;
`;

// ============================================
// Page Header
// ============================================

/**
 * Standard page header with border bottom.
 * Children should be LeftSection/RightSection or TitleSection/ActionsSection.
 */
export const PageHeader = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  gap: var(--space-sm);
`;

/**
 * Left side of header - typically back button + title.
 */
export const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

/**
 * Right side of header - action buttons.
 */
export const HeaderRight = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
`;

/**
 * Page title in header.
 */
export const HeaderTitle = styled.h1`
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  @media (min-width: 480px) {
    font-size: var(--font-size-xl);
  }
`;

/**
 * Actions visible only on desktop.
 */
export const DesktopActions = styled.div`
  display: none;
  gap: var(--space-sm);

  @media (min-width: 480px) {
    display: flex;
  }
`;

/**
 * Actions visible only on mobile.
 */
export const MobileActions = styled.div`
  display: flex;
  gap: var(--space-xs);

  @media (min-width: 480px) {
    display: none;
  }
`;

// ============================================
// Section Layout
// ============================================

/**
 * Content section with bottom margin.
 */
export const Section = styled.section`
  margin-bottom: var(--space-xl);
`;

/**
 * Section header with title and optional actions.
 */
export const SectionHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-md);
  gap: var(--space-sm);
`;

/**
 * Section title (h2 level).
 */
export const SectionTitle = styled.h2`
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--color-text);
`;

/**
 * Group of action buttons.
 */
export const ActionGroup = styled.div`
  display: flex;
  gap: var(--space-sm);
  align-items: center;
`;

// ============================================
// Cards
// ============================================

/**
 * Standard card with border and padding.
 */
export const Card = styled.div`
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-md);
`;

/**
 * Card that highlights on hover.
 */
export const InteractiveCard = styled(Card)`
  cursor: pointer;
  transition: border-color 0.2s ease;

  &:hover {
    border-color: var(--color-primary);
  }
`;

/**
 * Card header row.
 */
export const CardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
`;

/**
 * Card title.
 */
export const CardTitle = styled.h3`
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text);
`;

// ============================================
// Forms
// ============================================

/**
 * Form container with vertical gap.
 */
export const Form = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
`;

/**
 * Single form field with label and input.
 */
export const FormField = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

/**
 * Form field label.
 */
export const Label = styled.label`
  font-weight: 500;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
`;

/**
 * Horizontal row of form elements.
 */
export const FormRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

/**
 * Danger zone section in forms/modals.
 */
export const DangerZone = styled.div`
  margin-top: var(--space-lg);
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
`;

// ============================================
// Loading & Empty States
// ============================================

/**
 * Centered loading spinner container.
 */
export const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  padding: var(--space-2xl);
`;

/**
 * Empty state message.
 */
export const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-xl);
  color: var(--color-text-secondary);
  text-align: center;
`;

/**
 * Empty state in a list context.
 */
export const EmptyListState = styled(EmptyState)`
  background: var(--color-bg-muted);
  border-radius: var(--radius-md);
`;

// ============================================
// Dividers
// ============================================

/**
 * Horizontal divider line.
 */
export const Divider = styled.hr`
  border: none;
  height: 1px;
  background-color: var(--color-border);
  margin: var(--space-md) 0;
`;

/**
 * Light divider for subtle separation.
 */
export const LightDivider = styled(Divider)`
  background-color: var(--color-border-light);
`;

// ============================================
// Grid Layouts
// ============================================

/**
 * Responsive grid that adapts column count to screen size.
 */
export const ResponsiveGrid = styled.div<{ $minWidth?: string }>`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(${props => props.$minWidth || "280px"}, 1fr));
  gap: var(--space-md);
`;

/**
 * Widget grid (1 col mobile, 2 col tablet, 3 col desktop).
 */
export const WidgetGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-sm);

  @media (min-width: 400px) {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-md);
  }

  @media (min-width: 600px) {
    grid-template-columns: repeat(3, 1fr);
  }

  /* Prevent grid items from overflowing */
  & > * {
    min-width: 0;
  }
`;
