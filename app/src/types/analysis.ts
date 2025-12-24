/**
 * Analysis Output Types
 * Matches the schema from core/src/output-schema.ts
 */

export interface AnalysisOutput {
  schemaVersion: '1.0';
  analyzedAt: string;
  document: DocumentInfo;
  chunks: ChunkWithText[];
  entities: EntityIndex;
  timeline: TimelineView;
  plotThreads: PlotThreadView[];
  issues: IssueWithContext[];
  summary: AnalysisSummary;
}

export interface DocumentInfo {
  title: string;
  wordCount: number;
  charCount: number;
  chapterCount: number;
  source?: {
    filename: string;
    format: 'docx' | 'txt' | 'md';
  };
}

export interface ChunkWithText {
  id: string;
  title: string | null;
  text: string;
  startOffset: number;
  endOffset: number;
  extraction: ChunkExtraction;
}

export interface ChunkExtraction {
  events: EventExtraction[];
  characterMentions: CharacterMention[];
  facts: FactExtraction[];
  plotThreads: PlotThreadTouch[];
  setups: SetupExtraction[];
  openQuestions: string[];
}

export interface EventExtraction {
  id: string;
  description: string;
  timeMarker: string;
  precision: 'exact' | 'relative' | 'vague';
  characterIds: string[];
  location: TextLocation;
}

export interface CharacterMention {
  characterId: string;
  name: string;
  role: 'present' | 'mentioned' | 'flashback';
  location: TextLocation;
  attributesMentioned: string[];
}

export interface FactExtraction {
  id: string;
  content: string;
  category: 'character' | 'world' | 'location' | 'object' | 'relationship' | 'other';
  subject: string;
  entityId?: string;
  location: TextLocation;
  contradicts?: {
    factId: string;
    issueId: string;
  };
}

export interface PlotThreadTouch {
  threadId: string;
  action: 'introduced' | 'advanced' | 'complicated' | 'resolved';
  description: string;
  location: TextLocation;
}

export interface SetupExtraction {
  id: string;
  description: string;
  weight: 'subtle' | 'moderate' | 'heavy';
  impliedPayoff: string;
  location: TextLocation;
  payoff?: {
    chunkId: string;
    description: string;
    location: TextLocation;
  };
  status: 'pending' | 'resolved' | 'orphaned';
  issueId?: string;
}

export interface TextLocation {
  chunkId: string;
  startOffset: number;
  endOffset: number;
  snippet: string;
  humanReadable: string;
}

export interface EntityIndex {
  characters: CharacterEntity[];
  locations: LocationEntity[];
  objects: ObjectEntity[];
}

export interface CharacterEntity {
  id: string;
  name: string;
  aliases: string[];
  attributes: CharacterAttribute[];
  appearances: CharacterAppearance[];
  relationships: CharacterRelationship[];
  eventIds: string[];
  issueIds: string[];
  stats: {
    firstAppearance: string;
    lastAppearance: string;
    totalMentions: number;
    presentInChunks: number;
  };
}

export interface CharacterAttribute {
  attribute: string;
  value: string;
  location: TextLocation;
  conflictsWith?: {
    attributeIndex: number;
    issueId: string;
  };
}

export interface CharacterAppearance {
  chunkId: string;
  role: 'present' | 'mentioned' | 'flashback';
  mentions: TextLocation[];
}

export interface CharacterRelationship {
  targetCharacterId: string;
  targetName: string;
  relationship: string;
  sharedEventIds: string[];
}

export interface LocationEntity {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  appearances: Array<{
    chunkId: string;
    mentions: TextLocation[];
  }>;
  parentLocationId?: string;
}

export interface ObjectEntity {
  id: string;
  name: string;
  description?: string;
  significance: 'normal' | 'emphasized' | 'chekhov';
  appearances: Array<{
    chunkId: string;
    mentions: TextLocation[];
    action?: 'introduced' | 'used' | 'mentioned';
  }>;
  payoffStatus?: 'pending' | 'resolved' | 'abandoned';
  issueIds: string[];
}

export interface PlotThreadView {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'resolved' | 'abandoned';
  lifecycle: PlotThreadEvent[];
  issueIds: string[];
}

export interface PlotThreadEvent {
  chunkId: string;
  action: 'introduced' | 'advanced' | 'complicated' | 'resolved';
  description: string;
  location: TextLocation;
}

export interface TimelineView {
  events: TimelineEvent[];
  inconsistencies: TimelineInconsistency[];
  spans: TimeSpan[];
}

export interface TimelineEvent {
  eventId: string;
  position: number;
  confidence: number;
}

export interface TimelineInconsistency {
  description: string;
  eventIds: string[];
  issueId: string;
}

export interface TimeSpan {
  id: string;
  name: string;
  startPosition: number;
  endPosition: number;
  description?: string;
}

export interface IssueWithContext {
  id: string;
  type: IssueType;
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  chunkIds: string[];
  evidence: EvidenceItem[];
  relatedEntityIds: string[];
  status: 'open' | 'dismissed' | 'fixed';
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
  quote: string;
  location: TextLocation;
  note?: string;
}

export interface AnalysisSummary {
  totalChunks: number;
  characterCount: number;
  locationCount: number;
  objectCount: number;
  eventCount: number;
  plotThreadCount: number;
  unresolvedThreadCount: number;
  setupCount: number;
  unresolvedSetupCount: number;
  issueCount: number;
  issuesByType: Record<IssueType, number>;
  issuesBySeverity: {
    error: number;
    warning: number;
    info: number;
  };
}
