/**
 * Document parser - converts .docx files to structured text
 */
import type { ParsedDocument } from './types.js';
export interface ParseOptions {
    /** Path to the .docx file */
    filePath?: string;
    /** Raw buffer of the .docx file (for browser/cloud use) */
    buffer?: Buffer | ArrayBuffer;
}
/**
 * Parse a document file into structured text
 * Supports .docx and .txt files
 */
export declare function parseDocument(options: ParseOptions): Promise<ParsedDocument>;
/**
 * Parse plain text (for .txt files or pasted content)
 */
export declare function parseText(text: string, title?: string): ParsedDocument;
//# sourceMappingURL=parser.d.ts.map