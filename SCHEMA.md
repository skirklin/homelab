# Firestore Schema

This document describes the Firestore data model for all apps in this monorepo.

## Unified Event Pattern

All apps use a unified `events` subcollection for tracking user activity:

```typescript
events/{eventId} {
  subjectId: string      // ID of the thing acted on (recipeId, widgetId, taskId)
  timestamp: Timestamp   // When the event occurred
  createdAt: Timestamp   // When it was logged (may differ for backdated entries)
  createdBy: string      // User ID
  data: {                // Type-specific payload
    notes?: string
    ...otherFields
  }
}
```

This enables the cross-app Timeline view in the home app.

---

## Collections

### `users/{userId}`

Shared user profile data across all apps.

| Field | Type | Description |
|-------|------|-------------|
| `lifeLogId` | string | Reference to user's life log |
| `fcmToken` | string? | Single FCM token (life tracker) |
| `fcmTokens` | string[]? | Multiple FCM tokens (upkeep) |
| `householdSlugs` | {slug: listId} | Upkeep task list aliases |
| `slugs` | {slug: listId} | Grocery list aliases |

---

### `boxes/{boxId}` (Recipes)

Recipe box containers.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Box name |
| `owners` | string[] | User IDs with access |
| `visibility` | string | `"private"`, `"public"`, or `"unlisted"` |
| `created` | Timestamp | Creation time |
| `updated` | Timestamp | Last update time |

#### `boxes/{boxId}/recipes/{recipeId}`

Individual recipes using [schema.org Recipe](https://schema.org/Recipe) format.

| Field | Type | Description |
|-------|------|-------------|
| `data` | Recipe | Schema.org Recipe object |
| `owners` | string[] | User IDs with access |
| `visibility` | string | Recipe-level visibility override |
| `enrichmentStatus` | string? | `"needed"`, `"pending"`, `"skipped"` |
| `pendingEnrichment` | object? | AI-generated suggestions awaiting review |
| `created` | Timestamp | Creation time |
| `updated` | Timestamp | Last update time |

#### `boxes/{boxId}/events/{eventId}`

Cooking log entries.

| Field | Type | Description |
|-------|------|-------------|
| `subjectId` | string | Recipe ID that was cooked |
| `timestamp` | Timestamp | When it was cooked |
| `createdAt` | Timestamp | When the entry was logged |
| `createdBy` | string | User ID |
| `data.notes` | string? | Optional cooking notes |

---

### `lists/{listId}` (Groceries)

Grocery list containers.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | List name |
| `owners` | string[] | User IDs with access |
| `created` | Timestamp | Creation time |
| `updated` | Timestamp | Last update time |

#### `lists/{listId}/items/{itemId}`

Grocery items.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Item name |
| `category` | string? | Aisle/category |
| `quantity` | number? | Amount |
| `unit` | string? | Unit of measure |
| `notes` | string? | Additional notes |
| `checked` | boolean | Whether item is checked off |
| `addedBy` | string | User ID who added it |
| `addedAt` | Timestamp | When it was added |

#### `lists/{listId}/history/{itemName}`

Item usage history for suggestions.

| Field | Type | Description |
|-------|------|-------------|
| `lastCategory` | string | Last used category |
| `lastUnit` | string | Last used unit |
| `useCount` | number | Times this item has been added |

#### `lists/{listId}/trips/{tripId}`

Shopping trip records.

| Field | Type | Description |
|-------|------|-------------|
| `items` | array | Items purchased |
| `completedAt` | Timestamp | When trip was completed |
| `completedBy` | string | User ID |

---

### `lifeLogs/{logId}` (Life Tracker)

Life tracker containers with widget configuration.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Log name |
| `owners` | string[] | User IDs with access |
| `manifest` | LifeManifest | Widget and sampling configuration |
| `sampleSchedule` | object? | Today's random sampling schedule |
| `created` | Timestamp | Creation time |
| `updated` | Timestamp | Last update time |

**LifeManifest structure:**
```typescript
{
  widgets: [
    { id, type, label, ...typeSpecificFields }
  ],
  randomSamples: {
    enabled: boolean,
    timesPerDay: number,
    activeHours: [startHour, endHour],
    questions: [{ id, type, label, ...}]
  }
}
```

**Widget types:** `counter`, `number`, `rating`, `text`, `combo`

#### `lifeLogs/{logId}/events/{eventId}`

Life tracker entries.

| Field | Type | Description |
|-------|------|-------------|
| `subjectId` | string | Widget ID |
| `timestamp` | Timestamp | When the event occurred |
| `createdAt` | Timestamp | When it was logged |
| `createdBy` | string | User ID |
| `data.source` | string? | `"manual"` or `"sample"` |
| `data.notes` | string? | Optional notes |
| `data.*` | varies | Widget-specific data (rating, value, text, etc.) |

---

### `taskLists/{listId}` (Upkeep)

Household task list containers.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | List name |
| `owners` | string[] | User IDs with access |
| `roomDefs` | RoomDef[] | Room/area definitions |
| `created` | Timestamp | Creation time |
| `updated` | Timestamp | Last update time |

**RoomDef structure:** `{ id: string, name: string }`

#### `taskLists/{listId}/tasks/{taskId}`

Recurring household tasks.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Task name |
| `description` | string | Task description |
| `roomId` | string | Room/area ID |
| `frequency` | Frequency | How often task should be done |
| `lastCompleted` | Timestamp? | When task was last completed |
| `notifyUsers` | string[] | User IDs to notify when due |
| `createdBy` | string | User ID who created it |
| `createdAt` | Timestamp | Creation time |
| `updatedAt` | Timestamp | Last update time |

**Frequency structure:** `{ value: number, unit: "days" | "weeks" | "months" }`

#### `taskLists/{listId}/events/{eventId}`

Task completion records.

| Field | Type | Description |
|-------|------|-------------|
| `subjectId` | string | Task ID |
| `timestamp` | Timestamp | When task was completed |
| `createdAt` | Timestamp | When it was logged |
| `createdBy` | string | User ID who completed it |
| `data.notes` | string? | Optional completion notes |

---

## Indexes

See `firestore.indexes.json` for composite indexes. Key indexes:

- `events` collection: `(createdBy, timestamp desc)` and `(subjectId, timestamp desc)`
- `recipes` collection group: `(enrichmentStatus, created)` for batch enrichment

## Security Rules

See `firestore.rules`. General pattern:
- Container documents (`boxes`, `lists`, `lifeLogs`, `taskLists`) check `owners` array
- Subcollections inherit access from parent container via `get()` lookup
- Some containers allow any authenticated user to read metadata (for sharing via ID)
