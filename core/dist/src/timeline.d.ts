/**
 * Timeline Reconstruction
 *
 * Takes events from chunks and attempts to:
 * 1. Order them chronologically
 * 2. Detect temporal relationships
 * 3. Find timeline inconsistencies
 */
import type { ChunkWithText, TimelineView } from './output-schema.js';
/**
 * Reconstruct timeline from events across chunks
 */
export declare function reconstructTimeline(chunks: ChunkWithText[]): TimelineView;
//# sourceMappingURL=timeline.d.ts.map