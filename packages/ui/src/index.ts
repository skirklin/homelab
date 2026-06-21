// Formatting + date-math helpers (hoisted from per-app copies)
export {
  daysBetween,
  fmtDollarAbbrev,
  fmtDollarAbbrevB,
  fmtDollarWhole,
  fmtDollarWholeSigned,
  fmtDollarSignedExplicit,
  fmtDollarSignedMinus,
} from "./format";

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
  useObserverBackend,
  useChatBackend,
  useWpbDebug,
} from "./backend-provider";

// Auth
export { AuthProvider, useAuth, AuthContext } from "./auth";
export type { User } from "./auth";
export { LoginScreen } from "./LoginScreen";
export { getListInfo, joinList, getInviteInfo, getApiBase, getAuthHeaders } from "./api";

// Storage
export { createAppStorage, migrateStorageKey } from "./appStorage";
export type { AppStorage } from "./appStorage";

// Online/offline
export { useOnline, OfflineBanner } from "./online-status";
export { SyncStatusBanner, SyncDot } from "./sync-status";
export type { SyncDotProps } from "./sync-status";

// Service worker update detection
export { useUpdateAvailable } from "./sw-register";
export { UpdateAvailableBanner } from "./update-available-banner";

// List Management
export { ListPicker, JoinList, sanitizeSlug } from "./ListManagement";
export type {
  ListPickerConfig,
  ListPickerProps,
  ListOperations,
  JoinListConfig,
  JoinListProps,
} from "./ListManagement";

// Shared types
export type {
  LifeEvent,
  LifeEntry,
  UserProfile,
  UserProfileStore,
  NotificationMode,
  PushSubscriptionInfo,
} from "./types";

// UI Components
export { AppHeader } from "./AppHeader";
export type { AppHeaderProps } from "./AppHeader";
export { ShareModal } from "./ShareModal";
export { ErrorBoundary } from "./ErrorBoundary";
export { NotFound } from "./NotFound";
export type { NotFoundProps, NotFoundShortcut } from "./NotFound";

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

// Cross-app user display-name resolver (backed by the `user_names` view)
export { useUserNames } from "./useUserNames";

// Task assignee chips + picker (shared by upkeep outliner/board + travel checklist)
export { AssigneePicker, initialsOf } from "./AssigneePicker";
export type { AssigneePickerProps } from "./AssigneePicker";

// URL param hook
export { useUrlParam, useUrlString, useUrlParams } from "./useUrlParam";
export type {
  UseUrlParamOptions,
  UseUrlStringOptions,
  UseUrlParamsOptions,
  UrlParamSpec,
  UrlParamsSpec,
  UrlParamSetOptions,
  UrlParamSetter,
  UrlParamsSetter,
} from "./useUrlParam";

// Scroll restoration for legacy <BrowserRouter> apps
export { useScrollRestoration, ScrollRestoration } from "./useScrollRestoration";

// Test utilities — imported directly from "@kirkl/shared/test-utils" in test files,
// NOT re-exported here to avoid pulling Node.js globals (process.env) into browser bundles.
