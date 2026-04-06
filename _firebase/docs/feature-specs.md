# Feature Specifications

## 1. Backup/Restore

### Overview
Allow users to create full backups of their data and restore from backups for safety.

### Data Scope
All user data across apps:
- **Recipes**: boxes, recipes, cooking events
- **Groceries**: lists, items
- **Upkeep**: task lists, tasks, completion events
- **Life Tracker**: logs, manifests, entries

### Implementation Options

#### Option A: Client-Side Export/Import (Recommended for MVP)
**Pros**: Simple, no cloud costs, works offline, user owns their data
**Cons**: Manual process, no automatic scheduling

```typescript
// Export structure
interface FullBackup {
  version: 1;
  createdAt: string;
  userId: string;
  data: {
    recipes: {
      boxes: BoxData[];
      recipes: RecipeData[];
      events: EventData[];
    };
    groceries: {
      lists: ListData[];
      items: ItemData[];
    };
    upkeep: {
      taskLists: TaskListData[];
      tasks: TaskData[];
      events: EventData[];
    };
    life: {
      logs: LogData[];
      entries: EntryData[];
    };
  };
}
```

**UI Location**: Settings page in home app
- "Export Full Backup" button -> downloads JSON file
- "Restore from Backup" button -> file picker + confirmation modal
- Show backup metadata (date, size, counts) before restore
- Warn about overwriting existing data

#### Option B: Cloud Functions with Firebase Storage
**Pros**: Automatic scheduled backups, stored in cloud
**Cons**: Storage costs, more complex

```typescript
// Cloud function: scheduledBackup
// Runs weekly, stores in Firebase Storage
// Retains last 4 backups per user
```

### Restore Strategy
1. **Merge mode**: Add missing items, skip duplicates (by ID)
2. **Replace mode**: Delete all existing data, restore from backup
3. User chooses mode in confirmation dialog

### Security Considerations
- Validate backup structure before restore
- Verify user owns the backup (check userId)
- Rate limit restore operations
- Log restore events for audit

---

## 2. External Data Sources (Fitbit, Google Health)

### Overview
Import health/fitness data from external providers to correlate with life tracker entries.

### Supported Sources

#### Google Fit / Health Connect
- **Data types**: Steps, sleep, heart rate, activity
- **Auth**: Google OAuth 2.0
- **API**: REST API (Fitness API) or Health Connect SDK (Android)

#### Fitbit
- **Data types**: Steps, sleep stages, heart rate, activity
- **Auth**: OAuth 2.0
- **API**: Fitbit Web API

#### Apple HealthKit (Future - iOS app required)
- Requires native iOS app

### Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Client App    │────▶│  Cloud Function  │────▶│  External API   │
│  (OAuth flow)   │     │  (fetch & store) │     │ (Fitbit/Google) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │    Firestore     │
                        │ (external_data)  │
                        └──────────────────┘
```

### Data Model

```typescript
// New collection: externalData/{userId}/sources/{sourceId}
interface ExternalSource {
  provider: "fitbit" | "google_fit" | "apple_health";
  connected: boolean;
  lastSync: Timestamp;
  accessToken: string; // encrypted
  refreshToken: string; // encrypted
  scopes: string[];
}

// New collection: externalData/{userId}/metrics/{date}
interface DailyMetrics {
  date: string; // "2024-01-15"
  steps?: number;
  sleepMinutes?: number;
  sleepQuality?: number; // derived from sleep stages
  restingHeartRate?: number;
  activeMinutes?: number;
  source: string;
  syncedAt: Timestamp;
}
```

### Sync Strategy
1. **Initial sync**: Fetch last 30 days on connection
2. **Incremental sync**: Cloud function runs daily, fetches previous day
3. **Manual refresh**: User can trigger sync from settings

### UI Integration
- Settings page: Connect/disconnect external sources
- Life Tracker insights: Show external metrics alongside tracked data
- Correlation view: Compare sleep quality (external) vs mood (tracked)

### Privacy & Security
- Store tokens encrypted in Firestore
- User can disconnect and delete external data anytime
- Clear data retention policy (e.g., keep 1 year)
- Comply with each provider's API terms

### Implementation Phases
1. **Phase 1**: Google Fit integration (simplest OAuth, web-friendly)
2. **Phase 2**: Fitbit integration
3. **Phase 3**: Correlation visualizations

---

## 3. Data Export API

### Overview
Provide programmatic access to user data for external analysis tools.

### Use Cases
- Export to spreadsheet for personal analysis
- Feed into personal data dashboards
- Academic/research use
- Integration with other tools (Obsidian, Notion, etc.)

### Implementation Options

#### Option A: Enhanced Client Export (Recommended for MVP)
Extend existing export with more formats and filtering:

```typescript
interface ExportOptions {
  format: "json" | "csv" | "sqlite";
  dateRange?: { start: Date; end: Date };
  apps?: ("recipes" | "groceries" | "upkeep" | "life")[];
  includeDeleted?: boolean;
}
```

**Formats**:
- **JSON**: Full structure, machine-readable
- **CSV**: Flat tables, spreadsheet-friendly
- **SQLite**: Portable database file for SQL queries

#### Option B: REST API with Auth Tokens
Full API for external tools:

```typescript
// User generates API token in settings
// Token has scopes (read:life, read:recipes, etc.)

// Endpoints
GET /api/v1/life/entries?from=2024-01-01&to=2024-01-31
GET /api/v1/recipes/boxes
GET /api/v1/upkeep/completions
```

**Security**:
- Personal access tokens (like GitHub)
- Token scopes limit access
- Rate limiting
- Audit logging

#### Option C: Webhook Integration
Push data to external services on events:

```typescript
interface WebhookConfig {
  url: string;
  events: ("life.entry.created" | "upkeep.task.completed" | ...)[];
  secret: string;
}
```

### Recommended Approach

**Phase 1**: Enhanced client export (CSV, JSON with filters)
**Phase 2**: API tokens with read-only endpoints
**Phase 3**: Webhooks for real-time integrations

### Export Schemas

#### Life Tracker CSV
```csv
timestamp,widget_id,widget_label,type,value,notes
2024-01-15T08:30:00Z,meds,Meds,counter,1,
2024-01-15T07:00:00Z,sleep,Sleep,combo,"{hours:7.5,quality:4}",Woke up once
```

#### Upkeep CSV
```csv
timestamp,task_id,task_name,frequency,notes
2024-01-15T10:00:00Z,abc123,Clean bathroom,weekly,Used new cleaner
```

### API Rate Limits
- Free tier: 100 requests/day
- Enhanced: 1000 requests/day
- Batch endpoints for bulk access

---

## Priority Recommendation

1. **Backup/Restore (Option A)** - High value, low effort, immediate safety benefit
2. **Data Export API (Phase 1)** - Enhanced exports are quick wins
3. **External Sources (Phase 1)** - Google Fit is most accessible

Total estimated effort:
- Backup/Restore: 2-3 days
- Enhanced Export: 1-2 days
- Google Fit Integration: 1 week (OAuth complexity)
