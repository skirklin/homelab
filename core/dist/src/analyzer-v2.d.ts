/**
 * Analyzer v2 - Produces the enhanced AnalysisOutput format
 *
 * Orchestrates:
 * 1. Extraction (per-chunk)
 * 2. Entity aggregation
 * 3. Timeline reconstruction
 * 4. Issue detection
 */
import type { AnalysisOutput } from './output-schema.js';
export interface AnalyzerV2Options {
    apiKey?: string;
    model?: string;
    onProgress?: (phase: string, completed: number, total: number) => void;
}
/**
 * Run full analysis and produce AnalysisOutput
 */
export declare function analyzeDocumentV2(input: string | Buffer, options?: AnalyzerV2Options): Promise<AnalysisOutput>;
//# sourceMappingURL=analyzer-v2.d.ts.map