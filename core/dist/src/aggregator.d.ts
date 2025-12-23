/**
 * Entity Aggregator - Links and deduplicates entities across chunks
 *
 * Takes the per-chunk extractions and produces:
 * - Deduplicated character list with all appearances/attributes
 * - Aggregated locations and objects
 * - Linked plot threads with lifecycle
 * - Character IDs assigned to events and mentions
 */
import type { ChunkWithText, EntityIndex, PlotThreadView } from './output-schema.js';
export interface AggregationResult {
    entities: EntityIndex;
    plotThreads: PlotThreadView[];
    /** Updated chunks with linked IDs */
    chunks: ChunkWithText[];
}
/**
 * Aggregate entities across all chunks
 */
export declare function aggregateEntities(chunks: ChunkWithText[]): AggregationResult;
//# sourceMappingURL=aggregator.d.ts.map