// Backend
export { initializeBackend, getBackend } from "./backend";

// Backend Provider & Hooks
export {
  BackendProvider,
  useShoppingBackend,
  useRecipesBackend,
  useUpkeepBackend,
  useTravelBackend,
  useLifeBackend,
  useUserBackend,
} from "./backend-provider";

// Auth
export { AuthProvider, useAuth, AuthContext } from "./auth";
export type { User } from "./auth";
export { LoginScreen } from "./LoginScreen";
export { getListInfo, joinList } from "./api";

// Storage
export { createAppStorage, migrateStorageKey } from "./appStorage";
export type { AppStorage } from "./appStorage";

// Online/offline
export { useOnline, OfflineBanner } from "./online-status";

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

// Ant Design feedback hook
export { useFeedback } from "./useFeedback";

// Test utilities — imported directly from "@kirkl/shared/test-utils" in test files,
// NOT re-exported here to avoid pulling Node.js globals (process.env) into browser bundles.
