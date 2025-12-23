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
export type {
  ParsedDocument,
  Heading,
  Chunk,
  ChunkExtraction,
  TimelineEvent,
  CharacterMention,
  Fact,
  PlotThread,
  Setup,
  AnalysisResult,
  Issue,
  IssueType,
} from './types.js';

// Parser
export { parseDocument, parseText } from './parser.js';
export type { ParseOptions } from './parser.js';

// Chunker
export { chunkDocument, estimateTokens } from './chunker.js';
export type { ChunkOptions } from './chunker.js';

// Extractor
export { extractFromChunks, extractSingle } from './extractor.js';
export type { ExtractorOptions } from './extractor.js';

// Analyzer
export { analyzeExtractions } from './analyzer.js';
export type { AnalyzerOptions } from './analyzer.js';

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

// V2 Analysis (enhanced output format)
export { analyzeDocumentV2 } from './analyzer-v2.js';
export type { AnalyzerV2Options } from './analyzer-v2.js';

// V2 Output Schema (for frontend)
export type {
  AnalysisOutput,
  DocumentInfo,
  ChunkWithText,
  ChunkExtraction as ChunkExtractionV2,
  EventExtraction,
  CharacterMention as CharacterMentionV2,
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
  TimelineEvent as TimelineEventV2,
  TimelineInconsistency,
  TimeSpan,
  IssueWithContext,
  IssueType as IssueTypeV2,
  EvidenceItem,
  AnalysisSummary,
} from './output-schema.js';

/**
 * High-level convenience function: analyze a document end-to-end
 */
import { parseDocument, parseText } from './parser.js';
import { chunkDocument } from './chunker.js';
import { extractFromChunks } from './extractor.js';
import { analyzeExtractions } from './analyzer.js';
import type { AnalysisResult } from './types.js';
import type { ParseOptions } from './parser.js';
import type { ChunkOptions } from './chunker.js';
import type { ExtractorOptions } from './extractor.js';

export interface AnalyzeDocumentOptions {
  /** Parse options */
  parse?: ParseOptions;
  /** Chunking options */
  chunk?: Partial<ChunkOptions>;
  /** Extraction options (includes API key) */
  extract?: ExtractorOptions;
}

/**
 * Analyze a document end-to-end
 *
 * @param input - Either a file path, buffer, or raw text
 * @param options - Configuration options
 * @returns Analysis results with issues found
 */
export async function analyzeDocument(
  input: string | Buffer | ArrayBuffer,
  options: AnalyzeDocumentOptions = {}
): Promise<AnalysisResult> {
  // Parse
  let doc;
  if (typeof input === 'string' && !input.includes('\n') && input.endsWith('.docx')) {
    // Looks like a file path
    doc = await parseDocument({ filePath: input, ...options.parse });
  } else if (typeof input === 'string') {
    // Raw text
    doc = parseText(input);
  } else {
    // Buffer
    doc = await parseDocument({ buffer: input, ...options.parse });
  }

  // Chunk
  const chunks = chunkDocument(doc, options.chunk);

  // Extract
  const extractions = await extractFromChunks(chunks, options.extract);

  // Analyze
  const result = await analyzeExtractions(extractions, {
    apiKey: options.extract?.apiKey,
    model: options.extract?.model,
  });

  return result;
}
