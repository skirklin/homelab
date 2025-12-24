/**
 * Core types used internally by the parser and chunker
 */

export interface ParsedDocument {
  title: string;
  paragraphs: string[];
  headings: Heading[];
  fullText: string;
}

export interface Heading {
  text: string;
  level: number;
  paragraphIndex: number;
}

export interface Chunk {
  id: string;
  title: string | null;
  content: string;
  startIndex: number;
  endIndex: number;
}
