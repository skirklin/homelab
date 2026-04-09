// Backend
export { initializeBackend, getBackend } from "./backend";

// Auth
export { AuthProvider, useAuth, AuthContext } from "./auth";
export type { User } from "./auth";

// Storage
export { createAppStorage, migrateStorageKey } from "./appStorage";
export type { AppStorage } from "./appStorage";

// List Management
export { ListPicker, JoinList } from "./ListManagement";
export type {
  ListPickerConfig,
  ListPickerProps,
  ListOperations,
  JoinListConfig,
  JoinListProps,
} from "./ListManagement";

// Shared types
export type {
  Event,
  EventStore,
  UserProfile,
  UserProfileStore,
  NotificationMode,
} from "./types";
export { eventFromStore, eventToStore } from "./types";

// UI Components
export { AppHeader } from "./AppHeader";
export type { AppHeaderProps } from "./AppHeader";
export { ShareModal } from "./ShareModal";

// Styled Components
export {
  // Layout
  PageContainer,
  WideContainer,
  // Header
  PageHeader,
  HeaderLeft,
  HeaderRight,
  HeaderTitle,
  DesktopActions,
  MobileActions,
  // Sections
  Section,
  SectionHeader,
  SectionTitle,
  ActionGroup,
  // Cards
  Card,
  InteractiveCard,
  CardHeader,
  CardTitle,
  // Forms
  Form,
  FormField,
  Label,
  FormRow,
  DangerZone,
  // States
  LoadingContainer,
  EmptyState,
  EmptyListState,
  // Dividers
  Divider,
  LightDivider,
  // Grids
  ResponsiveGrid,
  WidgetGrid,
} from "./styles";

// PocketBase subscription helpers
export { subscribeToRecord, subscribeToCollection, subscribeToCollectionReload } from "./subscribe";

// Ant Design feedback hook
export { useFeedback } from "./useFeedback";

// Test utilities — imported directly from "@kirkl/shared/test-utils" in test files,
// NOT re-exported here to avoid pulling Node.js globals (process.env) into browser bundles.
