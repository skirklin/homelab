/**
 * Enhanced Extractor v2 - Captures source text locations for frontend highlighting
 */
import type { Chunk } from './types.js';
import type { ChunkWithText } from './output-schema.js';
export interface ExtractorV2Options {
    apiKey?: string;
    model?: string;
    concurrency?: number;
    onProgress?: (completed: number, total: number, chunkId: string) => void;
}
/**
 * Extract structured data from chunks with source locations
 */
export declare function extractFromChunksV2(chunks: Chunk[], options?: ExtractorV2Options): Promise<ChunkWithText[]>;
//# sourceMappingURL=extractor-v2.d.ts.map