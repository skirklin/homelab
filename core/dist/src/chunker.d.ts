/**
 * Document chunker - splits documents into analyzable pieces
 */
import type { ParsedDocument, Chunk } from './types.js';
export interface ChunkOptions {
    /** Preferred chunk strategy */
    strategy: 'chapters' | 'size' | 'hybrid';
    /** Target chunk size in characters (for 'size' and 'hybrid' strategies) */
    targetSize?: number;
    /** Maximum chunk size (hard limit) */
    maxSize?: number;
    /** Minimum chunk size (avoid tiny chunks) */
    minSize?: number;
}
/**
 * Split a parsed document into chunks for analysis
 */
export declare function chunkDocument(doc: ParsedDocument, options?: Partial<ChunkOptions>): Chunk[];
/**
 * Utility: estimate token count (rough approximation)
 */
export declare function estimateTokens(text: string): number;
//# sourceMappingURL=chunker.d.ts.map