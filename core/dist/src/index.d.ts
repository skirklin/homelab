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
export type { ParsedDocument, Heading, Chunk, ChunkExtraction, TimelineEvent, CharacterMention, Fact, PlotThread, Setup, AnalysisResult, Issue, IssueType, } from './types.js';
export { parseDocument, parseText } from './parser.js';
export type { ParseOptions } from './parser.js';
export { chunkDocument, estimateTokens } from './chunker.js';
export type { ChunkOptions } from './chunker.js';
export { extractFromChunks, extractSingle } from './extractor.js';
export type { ExtractorOptions } from './extractor.js';
export { analyzeExtractions } from './analyzer.js';
export type { AnalyzerOptions } from './analyzer.js';
export { validateManuscriptDir, loadManuscriptDir, createManifest, compareIssues, } from './manifest.js';
export type { Manifest, ManifestSource, ManifestFiles, ManifestMetadata, ExpectedIssue, ExpectedIssuesFile, ValidationResult, } from './manifest.js';
export { analyzeDocumentV2 } from './analyzer-v2.js';
export type { AnalyzerV2Options } from './analyzer-v2.js';
export type { AnalysisOutput, DocumentInfo, ChunkWithText, ChunkExtraction as ChunkExtractionV2, EventExtraction, CharacterMention as CharacterMentionV2, FactExtraction, PlotThreadTouch, SetupExtraction, TextLocation, EntityIndex, CharacterEntity, CharacterAttribute, CharacterAppearance, CharacterRelationship, LocationEntity, ObjectEntity, PlotThreadView, PlotThreadEvent, TimelineView, TimelineEvent as TimelineEventV2, TimelineInconsistency, TimeSpan, IssueWithContext, IssueType as IssueTypeV2, EvidenceItem, AnalysisSummary, } from './output-schema.js';
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
export declare function analyzeDocument(input: string | Buffer | ArrayBuffer, options?: AnalyzeDocumentOptions): Promise<AnalysisResult>;
//# sourceMappingURL=index.d.ts.map