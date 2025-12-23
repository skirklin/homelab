/**
 * Enhanced Analysis Output Schema
 *
 * Designed to be a self-contained format that can power multiple frontend views:
 * - Issue list view
 * - Annotated manuscript view
 * - Timeline visualization
 * - Character/entity cards
 * - Plot thread tracker
 *
 * Key principles:
 * 1. Include source text so frontend doesn't need original document
 * 2. Use stable IDs for cross-referencing between entities
 * 3. Include location info precise enough for highlighting
 * 4. Aggregate entities across chunks for card views
 * 5. Preserve temporal relationships for timeline view
 */

// =============================================================================
// DOCUMENT STRUCTURE
// =============================================================================

/** The complete analysis output */
export interface AnalysisOutput {
  /** Schema version for forward compatibility */
  schemaVersion: '1.0';

  /** When the analysis was performed */
  analyzedAt: string; // ISO 8601

  /** Document metadata */
  document: DocumentInfo;

  /** The chunked document with source text preserved */
  chunks: ChunkWithText[];

  /** Aggregated entities (characters, locations, objects) */
  entities: EntityIndex;

  /** Reconstructed timeline */
  timeline: TimelineView;

  /** Plot threads with lifecycle */
  plotThreads: PlotThreadView[];

  /** All detected issues */
  issues: IssueWithContext[];

  /** Summary statistics */
  summary: AnalysisSummary;
}

export interface DocumentInfo {
  title: string;
  /** Total word count */
  wordCount: number;
  /** Total character count */
  charCount: number;
  /** Number of chapters/sections detected */
  chapterCount: number;
  /** Source file info */
  source?: {
    filename: string;
    format: 'docx' | 'txt' | 'md';
  };
}

// =============================================================================
// CHUNKS WITH SOURCE TEXT
// =============================================================================

/** A chunk with its source text preserved for the manuscript view */
export interface ChunkWithText {
  id: string;

  /** Chapter/section title if detected */
  title: string | null;

  /** The actual source text (for manuscript view highlighting) */
  text: string;

  /** Character offset in original document */
  startOffset: number;
  endOffset: number;

  /** Extraction results for this chunk */
  extraction: ChunkExtraction;
}

export interface ChunkExtraction {
  /** Events with precise locations */
  events: EventExtraction[];

  /** Character appearances with locations */
  characterMentions: CharacterMention[];

  /** Facts established with locations */
  facts: FactExtraction[];

  /** Plot thread touches */
  plotThreads: PlotThreadTouch[];

  /** Setups/foreshadowing */
  setups: SetupExtraction[];

  /** Open questions raised */
  openQuestions: string[];
}

// =============================================================================
// EVENTS & TIMELINE
// =============================================================================

export interface EventExtraction {
  id: string;

  /** What happened */
  description: string;

  /** Time marker from text */
  timeMarker: string;

  /** Normalized time for sorting (if determinable) */
  normalizedTime?: {
    /** Relative position in story (0-1) if absolute time unknown */
    relativePosition?: number;
    /** Absolute time if mentioned */
    absoluteTime?: string;
    /** Relative to another event */
    relativeTo?: {
      eventId: string;
      relation: 'before' | 'after' | 'during' | 'same_day';
      offset?: string; // "3 days later"
    };
  };

  /** How precise is the time marker */
  precision: 'exact' | 'relative' | 'vague';

  /** Character IDs involved */
  characterIds: string[];

  /** Location in source text */
  location: TextLocation;
}

/** Timeline view - events ordered with relationships */
export interface TimelineView {
  /** Events in chronological order (best effort) */
  events: TimelineEvent[];

  /** Detected timeline inconsistencies */
  inconsistencies: TimelineInconsistency[];

  /** Time spans (e.g., "the storm", "three days later") */
  spans: TimeSpan[];
}

export interface TimelineEvent {
  eventId: string;
  /** Position in timeline (0 = start, 1 = end) */
  position: number;
  /** Confidence in position (0-1) */
  confidence: number;
}

export interface TimelineInconsistency {
  description: string;
  eventIds: string[];
  issueId: string; // Links to issue
}

export interface TimeSpan {
  id: string;
  name: string;
  startPosition: number;
  endPosition: number;
  description?: string;
}

// =============================================================================
// ENTITIES (Characters, Locations, Objects)
// =============================================================================

export interface EntityIndex {
  characters: CharacterEntity[];
  locations: LocationEntity[];
  objects: ObjectEntity[];
}

export interface CharacterEntity {
  id: string;

  /** Primary name */
  name: string;

  /** Alternative names/references */
  aliases: string[];

  /** All attributes mentioned across the document */
  attributes: CharacterAttribute[];

  /** Chunks where this character appears */
  appearances: CharacterAppearance[];

  /** Relationships to other characters */
  relationships: CharacterRelationship[];

  /** Issues involving this character */
  issueIds: string[];

  /** Summary stats */
  stats: {
    firstAppearance: string; // chunkId
    lastAppearance: string;
    totalMentions: number;
    presentInChunks: number;
  };
}

export interface CharacterAttribute {
  /** The attribute (e.g., "eye color", "age", "occupation") */
  attribute: string;

  /** The value (e.g., "blue", "73", "detective") */
  value: string;

  /** Where this was stated */
  location: TextLocation;

  /** If this conflicts with another attribute */
  conflictsWith?: {
    attributeIndex: number;
    issueId: string;
  };
}

export interface CharacterAppearance {
  chunkId: string;
  role: 'present' | 'mentioned' | 'flashback';
  /** Specific mentions in this chunk */
  mentions: TextLocation[];
}

export interface CharacterRelationship {
  targetCharacterId: string;
  relationship: string; // "spouse", "employer", "rival", etc.
  location: TextLocation;
}

export interface CharacterMention {
  characterId: string;
  name: string; // The actual text used
  role: 'present' | 'mentioned' | 'flashback';
  location: TextLocation;
  /** Any attributes mentioned in this appearance */
  attributesMentioned: string[];
}

export interface LocationEntity {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  /** Chunks where this location appears */
  appearances: Array<{
    chunkId: string;
    mentions: TextLocation[];
  }>;
  /** Parent location if hierarchical (room -> building -> city) */
  parentLocationId?: string;
}

export interface ObjectEntity {
  id: string;
  name: string;
  description?: string;
  /** Is this a Chekhov's gun? (introduced with significance) */
  significance: 'normal' | 'emphasized' | 'chekhov';
  appearances: Array<{
    chunkId: string;
    mentions: TextLocation[];
    action?: 'introduced' | 'used' | 'mentioned';
  }>;
  /** If this was set up, was it paid off? */
  payoffStatus?: 'pending' | 'resolved' | 'abandoned';
  issueIds: string[];
}

// =============================================================================
// PLOT THREADS
// =============================================================================

export interface PlotThreadView {
  id: string;

  /** Brief name for the thread */
  name: string;

  /** Longer description */
  description: string;

  /** Current status */
  status: 'active' | 'resolved' | 'abandoned';

  /** Lifecycle events */
  lifecycle: PlotThreadEvent[];

  /** Related issues (if unresolved/abandoned) */
  issueIds: string[];
}

export interface PlotThreadEvent {
  chunkId: string;
  action: 'introduced' | 'advanced' | 'complicated' | 'resolved';
  description: string;
  location: TextLocation;
}

export interface PlotThreadTouch {
  threadId: string;
  action: 'introduced' | 'advanced' | 'complicated' | 'resolved';
  description: string;
  location: TextLocation;
}

// =============================================================================
// SETUPS & FORESHADOWING
// =============================================================================

export interface SetupExtraction {
  id: string;

  /** What was set up */
  description: string;

  /** How heavy-handed */
  weight: 'subtle' | 'moderate' | 'heavy';

  /** What payoff this implies */
  impliedPayoff: string;

  /** Location in text */
  location: TextLocation;

  /** If resolved, link to the payoff */
  payoff?: {
    chunkId: string;
    description: string;
    location: TextLocation;
  };

  /** Status */
  status: 'pending' | 'resolved' | 'orphaned';

  /** Related issue if problematic */
  issueId?: string;
}

// =============================================================================
// FACTS
// =============================================================================

export interface FactExtraction {
  id: string;

  /** The fact itself */
  content: string;

  /** Category */
  category: 'character' | 'world' | 'location' | 'object' | 'relationship' | 'other';

  /** What/who it's about */
  subject: string;

  /** Entity ID if linked */
  entityId?: string;

  /** Location in text */
  location: TextLocation;

  /** If this contradicts another fact */
  contradicts?: {
    factId: string;
    issueId: string;
  };
}

// =============================================================================
// ISSUES
// =============================================================================

export interface IssueWithContext {
  id: string;

  type: IssueType;
  severity: 'error' | 'warning' | 'info';

  /** Short title */
  title: string;

  /** Detailed description */
  description: string;

  /** Chunks involved */
  chunkIds: string[];

  /** Specific locations with quotes */
  evidence: EvidenceItem[];

  /** Related entity IDs (characters, objects, etc.) */
  relatedEntityIds: string[];

  /** For UI: has the user dismissed/acknowledged this? */
  status: 'open' | 'dismissed' | 'fixed';

  /** User notes (for persistence) */
  userNote?: string;
}

export type IssueType =
  | 'timeline_inconsistency'
  | 'character_inconsistency'
  | 'fact_contradiction'
  | 'unresolved_thread'
  | 'orphaned_payoff'
  | 'missing_setup'
  | 'over_foreshadowed'
  | 'under_foreshadowed'
  | 'dropped_character'
  | 'dropped_object'
  | 'continuity_error';

export interface EvidenceItem {
  /** The quote from the text */
  quote: string;

  /** Where it appears */
  location: TextLocation;

  /** Why this is relevant */
  note?: string;
}

// =============================================================================
// TEXT LOCATIONS
// =============================================================================

/** Precise location in source text for highlighting */
export interface TextLocation {
  /** Chunk this appears in */
  chunkId: string;

  /** Character offsets within the chunk */
  startOffset: number;
  endOffset: number;

  /** The actual text (for verification/display without loading chunk) */
  snippet: string;

  /** Human-readable location */
  humanReadable: string; // "Chapter 3, paragraph 5"
}

// =============================================================================
// SUMMARY
// =============================================================================

export interface AnalysisSummary {
  /** Chunk stats */
  totalChunks: number;

  /** Entity counts */
  characterCount: number;
  locationCount: number;
  objectCount: number;

  /** Event/thread counts */
  eventCount: number;
  plotThreadCount: number;
  unresolvedThreadCount: number;

  /** Setup/payoff */
  setupCount: number;
  unresolvedSetupCount: number;

  /** Issue breakdown */
  issueCount: number;
  issuesByType: Record<IssueType, number>;
  issuesBySeverity: {
    error: number;
    warning: number;
    info: number;
  };
}
