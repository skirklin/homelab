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
// Parser
export { parseDocument, parseText } from './parser.js';
// Chunker
export { chunkDocument, estimateTokens } from './chunker.js';
// Extractor
export { extractFromChunks, extractSingle } from './extractor.js';
// Analyzer
export { analyzeExtractions } from './analyzer.js';
// Manifest validation
export { validateManuscriptDir, loadManuscriptDir, createManifest, compareIssues, } from './manifest.js';
// V2 Analysis (enhanced output format)
export { analyzeDocumentV2 } from './analyzer-v2.js';
/**
 * High-level convenience function: analyze a document end-to-end
 */
import { parseDocument, parseText } from './parser.js';
import { chunkDocument } from './chunker.js';
import { extractFromChunks } from './extractor.js';
import { analyzeExtractions } from './analyzer.js';
/**
 * Analyze a document end-to-end
 *
 * @param input - Either a file path, buffer, or raw text
 * @param options - Configuration options
 * @returns Analysis results with issues found
 */
export async function analyzeDocument(input, options = {}) {
    // Parse
    let doc;
    if (typeof input === 'string' && !input.includes('\n') && input.endsWith('.docx')) {
        // Looks like a file path
        doc = await parseDocument({ filePath: input, ...options.parse });
    }
    else if (typeof input === 'string') {
        // Raw text
        doc = parseText(input);
    }
    else {
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
//# sourceMappingURL=index.js.map