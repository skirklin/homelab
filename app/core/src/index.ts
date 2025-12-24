/**
 * Book Editor Core - Document analysis for writers
 *
 * This module provides the core functionality for analyzing manuscripts:
 * - Parse .docx files to structured text
 * - Chunk documents into analyzable sections
 * - Extract timeline, characters, plot threads, etc. from each chunk
 * - Analyze across chunks to find continuity issues
 *
 * Designed to be used from:
 * - CLI for local development
 * - Cloud Functions for production
 * - Browser (with some limitations on file reading)
 */

// Types
export type { ParsedDocument, Heading, Chunk } from './types.js';

// Parser
export { parseDocument, parseText } from './parser.js';
export type { ParseOptions } from './parser.js';

// Chunker
export { chunkDocument, estimateTokens } from './chunker.js';
export type { ChunkOptions } from './chunker.js';

// Manifest validation
export {
  validateManuscriptDir,
  loadManuscriptDir,
  createManifest,
  compareIssues,
} from './manifest.js';
export type {
  Manifest,
  ManifestSource,
  ManifestFiles,
  ManifestMetadata,
  ExpectedIssue,
  ExpectedIssuesFile,
  ValidationResult,
} from './manifest.js';

// Discovery pass
export { discoverEntities, formatDiscoveredContext } from './discovery.js';
export type {
  DiscoveryResult,
  DiscoveredEntities,
  DiscoveredCharacter,
  DiscoveredThread,
  DiscoveryOptions,
} from './discovery.js';

// Main analyzer
export { analyzeDocument } from './analyzer.js';
export type { AnalyzerOptions } from './analyzer.js';

// Cache
export { AnalysisCache, hashDiscoveredEntities } from './cache.js';
export type { CacheOptions } from './cache.js';

// Literary Critic Agent
export { runCritic, insightsToIssues } from './critic.js';
export type { CriticOptions, CriticFocusArea, CriticProgress, CriticResult, CriticIssue } from './critic.js';
export type { CriticInsight } from './critic-tools.js';

// Extractor
export type { ExtractionResult, ExtractorOptions } from './extractor.js';

// Output Schema (for frontend)
export type {
  AnalysisOutput,
  TokenUsage,
  DocumentInfo,
  ChunkWithText,
  ChunkExtraction,
  EventExtraction,
  CharacterMention,
  FactExtraction,
  PlotThreadTouch,
  SetupExtraction,
  TextLocation,
  EntityIndex,
  CharacterEntity,
  CharacterAttribute,
  CharacterAppearance,
  CharacterRelationship,
  LocationEntity,
  ObjectEntity,
  PlotThreadView,
  PlotThreadEvent,
  TimelineView,
  TimelineEvent,
  TimelineInconsistency,
  TimeSpan,
  IssueWithContext,
  IssueType,
  EvidenceItem,
  AnalysisSummary,
} from './output-schema.js';
