/**
 * Analyzer - finds issues across extracted chunk data
 */
import type { ChunkExtraction, AnalysisResult } from './types.js';
export interface AnalyzerOptions {
    /** Anthropic API key */
    apiKey?: string;
    /** Model to use */
    model?: string;
}
/**
 * Analyze extracted data to find issues
 */
export declare function analyzeExtractions(extractions: ChunkExtraction[], options?: AnalyzerOptions): Promise<AnalysisResult>;
//# sourceMappingURL=analyzer.d.ts.map