/**
 * Core types for book analysis
 */
/** A parsed document with structural information */
export interface ParsedDocument {
    title: string;
    fullText: string;
    /** Paragraphs with their raw text */
    paragraphs: string[];
    /** Detected headings/chapter markers */
    headings: Heading[];
}
export interface Heading {
    level: number;
    text: string;
    /** Index in paragraphs array where this heading appears */
    paragraphIndex: number;
}
/** A chunk of the document for analysis */
export interface Chunk {
    id: string;
    /** Chapter/section title if detected */
    title: string | null;
    /** The actual text content */
    content: string;
    /** Start position in original document (paragraph index) */
    startIndex: number;
    /** End position in original document (paragraph index) */
    endIndex: number;
}
/** Extracted information from a single chunk */
export interface ChunkExtraction {
    chunkId: string;
    /** Timeline events mentioned in this chunk */
    timelineEvents: TimelineEvent[];
    /** Characters appearing in this chunk */
    characters: CharacterMention[];
    /** Facts established (world-building, character details, etc.) */
    factsEstablished: Fact[];
    /** Plot threads touched (introduced, advanced, or resolved) */
    plotThreads: PlotThread[];
    /** Setups/promises that imply future payoff (foreshadowing) */
    setups: Setup[];
    /** Questions or mysteries raised for the reader */
    openQuestions: string[];
}
export interface TimelineEvent {
    /** What happened */
    description: string;
    /** When it happened (explicit date, relative time, or vague) */
    timeMarker: string;
    /** How precise is the time marker */
    precision: 'exact' | 'relative' | 'vague';
    /** Characters involved */
    characters: string[];
}
export interface CharacterMention {
    name: string;
    /** Any physical or personality details mentioned */
    details: string[];
    /** Role in this chunk (protagonist, antagonist, mentioned, etc.) */
    role: 'present' | 'mentioned' | 'flashback';
}
export interface Fact {
    /** The fact itself */
    content: string;
    /** What category (character detail, world rule, location, object, etc.) */
    category: 'character' | 'world' | 'location' | 'object' | 'relationship' | 'other';
    /** What/who it's about */
    subject: string;
}
export interface PlotThread {
    /** Brief name/description of the thread */
    name: string;
    /** What happened to this thread in this chunk */
    status: 'introduced' | 'advanced' | 'resolved';
    /** Details about what happened */
    details: string;
}
export interface Setup {
    /** What was set up/foreshadowed */
    description: string;
    /** How heavy-handed is the foreshadowing */
    weight: 'subtle' | 'moderate' | 'heavy';
    /** What payoff this seems to promise */
    impliedPayoff: string;
}
/** Analysis results for the whole document */
export interface AnalysisResult {
    /** All chunks that were analyzed */
    chunks: ChunkExtraction[];
    /** Issues found across the document */
    issues: Issue[];
    /** Summary statistics */
    summary: {
        totalChunks: number;
        totalCharacters: number;
        totalPlotThreads: number;
        unresolvedThreads: number;
        timelineEvents: number;
        issueCount: number;
    };
}
export interface Issue {
    type: IssueType;
    severity: 'error' | 'warning' | 'info';
    title: string;
    description: string;
    /** Which chunks are involved */
    chunkIds: string[];
    /** Specific quotes or references */
    evidence: string[];
}
export type IssueType = 'timeline_inconsistency' | 'character_inconsistency' | 'fact_contradiction' | 'unresolved_thread' | 'orphaned_payoff' | 'missing_setup' | 'over_foreshadowed' | 'under_foreshadowed' | 'dropped_character' | 'continuity_error';
//# sourceMappingURL=types.d.ts.map