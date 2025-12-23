/**
 * Extractor - uses Claude API to extract structured data from text chunks
 */
import type { Chunk, ChunkExtraction } from './types.js';
export interface ExtractorOptions {
    /** Anthropic API key (defaults to ANTHROPIC_API_KEY env var) */
    apiKey?: string;
    /** Model to use */
    model?: string;
    /** Maximum concurrent API calls */
    concurrency?: number;
    /** Progress callback */
    onProgress?: (completed: number, total: number, chunkId: string) => void;
}
/**
 * Extract structured information from chunks using Claude API
 */
export declare function extractFromChunks(chunks: Chunk[], options?: ExtractorOptions): Promise<ChunkExtraction[]>;
/**
 * Extract from a single chunk (exported for individual use)
 */
export declare function extractSingle(chunk: Chunk, options?: ExtractorOptions): Promise<ChunkExtraction>;
//# sourceMappingURL=extractor.d.ts.map