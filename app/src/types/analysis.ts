/**
 * Analysis Output Types
 * Matches the schema from critic/schema.py
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
  dialogue: DialogueLine[];
  scenes: SceneBreak[];
  openQuestions: string[];
}

export interface EventExtraction {
  id: string;
  description: string;
  timeMarker: string;
  precision: 'exact' | 'relative' | 'vague';
  sequenceNote?: string;
  characterIds: string[];
  location: TextLocation;
}

export interface CharacterMention {
  characterId: string;
  name: string;
  role: 'present' | 'mentioned' | 'flashback';
  location: TextLocation;
  attributesMentioned: string[];
  relationshipsMentioned: Array<{ target: string; relationship: string }>;
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
  name: string;
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

export interface DialogueLine {
  speaker: string;
  target?: string;
  summary: string;
  tone?: string;
  reveals: string[];
  location: TextLocation;
}

export interface SceneBreak {
  sceneNumber: number;
  location?: string;
  time?: string;
  charactersPresent: string[];
  povCharacter?: string;
  startOffset: number;
  endOffset: number;
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

export type AttributeCategory = 'physical' | 'personality' | 'occupation' | 'relationship' | 'state' | 'action';

export interface CharacterProfile {
  physical: string[];
  personality: string[];
  occupation?: string;
  keyRelationships: string[];
}

export interface CharacterEntity {
  id: string;
  name: string;
  aliases: string[];
  profile: CharacterProfile;
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
  category: AttributeCategory;
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
  description?: string;
}

export interface ObjectEntity {
  id: string;
  name: string;
  description?: string;
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

export interface TimelineEvent {
  eventId: string;
  description: string;
  normalizedTime: string;  // e.g., "Day 0, 9:00 AM"
  originalTimeMarker: string;  // Original text reference
  chapter: string;
  sequence: number;
  isFlashback: boolean;
  characterIds: string[];
  location?: string;
  chunkId: string;
}

export interface EntityTimeline {
  entityId: string;
  entityName: string;
  entityType: 'character' | 'location';
  events: TimelineEvent[];
}

export interface TimeAnchor {
  id: string;
  name: string;  // e.g., "Day 0 (Tuesday)"
  dayOffset: number;  // Relative to anchor point
  description?: string;
}

export interface TimelineView {
  anchorPoint: string;  // Description of Day 0
  globalEvents: TimelineEvent[];  // All events chronologically
  entityTimelines: EntityTimeline[];  // Per-character/location timelines
  timeAnchors: TimeAnchor[];
  chapters: string[];
}

export interface IssueWithContext {
  id: string;
  type: IssueType;
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  chunkIds: string[];
  evidence: EvidenceItem[];
  relatedEntityIds?: string[];
  status?: 'open' | 'dismissed' | 'fixed';
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
  location?: TextLocation;
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
  tokenUsage?: {
    discovery: { inputTokens: number; outputTokens: number };
    extraction: { inputTokens: number; outputTokens: number };
    total: { inputTokens: number; outputTokens: number };
  };
}
