/**
 * Enhanced Extractor v2 - Captures source text locations for frontend highlighting
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Chunk } from './types.js';
import type {
  ChunkWithText,
  ChunkExtraction,
  EventExtraction,
  CharacterMention,
  FactExtraction,
  PlotThreadTouch,
  SetupExtraction,
  TextLocation,
} from './output-schema.js';

export interface ExtractorV2Options {
  apiKey?: string;
  model?: string;
  concurrency?: number;
  onProgress?: (completed: number, total: number, chunkId: string) => void;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

const EXTRACTION_PROMPT = `You are analyzing a section of a novel manuscript. Extract structured information with EXACT QUOTES from the text.

For each item you extract, you MUST include:
1. The exact quote from the text (verbatim, word-for-word)
2. This quote will be used to locate the text in the original document, so accuracy is critical

Analyze the text and extract:

## 1. Events (things that happen)
For each event:
- description: What happened
- timeMarker: When (quote the exact time reference from text, or "unspecified")
- precision: "exact" (specific date/time), "relative" (e.g., "three days later"), or "vague" (e.g., "that morning")
- characters: Names of characters involved
- quote: The EXACT sentence(s) describing this event

## 2. Character Appearances
For each character that appears or is mentioned:
- name: Character's name
- role: "present" (in the scene), "mentioned" (talked about), or "flashback"
- attributes: Any physical or personality details mentioned (each with exact quote)
- quote: A quote showing their appearance/mention

## 3. Facts Established
Concrete details that could be contradicted later:
- content: The fact
- category: "character", "world", "location", "object", "relationship", or "other"
- subject: What/who it's about
- quote: EXACT quote establishing this fact

## 4. Plot Threads
Story threads touched in this section:
- name: Brief name for the thread
- action: "introduced", "advanced", or "resolved"
- description: What happened with this thread
- quote: Relevant quote

## 5. Setups/Foreshadowing
Things that seem to promise future payoff:
- description: What was set up
- weight: "subtle", "moderate", or "heavy"
- impliedPayoff: What this seems to promise
- quote: The setup text

## 6. Open Questions
Mysteries or questions raised for the reader (just list as strings)

Return as JSON:
{
  "events": [...],
  "characters": [...],
  "facts": [...],
  "plotThreads": [...],
  "setups": [...],
  "openQuestions": [...]
}

CRITICAL: Every quote must be EXACTLY as it appears in the text. Do not paraphrase.`;

interface RawExtraction {
  events?: Array<{
    description: string;
    timeMarker: string;
    precision: 'exact' | 'relative' | 'vague';
    characters: string[];
    quote: string;
  }>;
  characters?: Array<{
    name: string;
    role: 'present' | 'mentioned' | 'flashback';
    attributes?: Array<{ attribute: string; value: string; quote: string }>;
    quote: string;
  }>;
  facts?: Array<{
    content: string;
    category: string;
    subject: string;
    quote: string;
  }>;
  plotThreads?: Array<{
    name: string;
    action: 'introduced' | 'advanced' | 'resolved';
    description: string;
    quote: string;
  }>;
  setups?: Array<{
    description: string;
    weight: 'subtle' | 'moderate' | 'heavy';
    impliedPayoff: string;
    quote: string;
  }>;
  openQuestions?: string[];
}

/**
 * Extract structured data from chunks with source locations
 */
export async function extractFromChunksV2(
  chunks: Chunk[],
  options: ExtractorV2Options = {}
): Promise<ChunkWithText[]> {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const client = new Anthropic({ apiKey });
  const model = options.model || DEFAULT_MODEL;
  const concurrency = options.concurrency || 3;

  const results: ChunkWithText[] = [];
  let completed = 0;

  // Track character offset across chunks
  let currentOffset = 0;

  // Process in batches
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const offsets = batch.map((chunk, idx) => {
      const offset = currentOffset;
      currentOffset += chunks[i + idx].content.length + 1; // +1 for newline
      return offset;
    });

    const batchResults = await Promise.all(
      batch.map(async (chunk, idx) => {
        const result = await extractFromChunkV2(
          client,
          model,
          chunk,
          offsets[idx]
        );
        completed++;
        options.onProgress?.(completed, chunks.length, chunk.id);
        return result;
      })
    );

    results.push(...batchResults);
  }

  return results;
}

/**
 * Extract from a single chunk with location tracking
 */
async function extractFromChunkV2(
  client: Anthropic,
  model: string,
  chunk: Chunk,
  startOffset: number
): Promise<ChunkWithText> {
  const chunkContext = chunk.title
    ? `## Section: ${chunk.title}\n\n${chunk.content}`
    : chunk.content;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `${EXTRACTION_PROMPT}\n\n---\n\nTEXT TO ANALYZE:\n\n${chunkContext}`,
      },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const raw = parseJsonFromResponse(text) as RawExtraction;

  // Convert raw extraction to typed extraction with locations
  const extraction = processRawExtraction(raw, chunk);

  return {
    id: chunk.id,
    title: chunk.title,
    text: chunk.content,
    startOffset,
    endOffset: startOffset + chunk.content.length,
    extraction,
  };
}

/**
 * Process raw extraction and add text locations
 */
function processRawExtraction(
  raw: RawExtraction,
  chunk: Chunk
): ChunkExtraction {
  const findLocation = (quote: string): TextLocation => {
    return findTextLocation(quote, chunk.content, chunk.id);
  };

  // Process events
  const events: EventExtraction[] = (raw.events ?? []).map((e, idx) => ({
    id: `${chunk.id}-event-${idx}`,
    description: e.description,
    timeMarker: e.timeMarker,
    precision: e.precision,
    characterIds: [], // Will be linked in aggregation pass
    location: findLocation(e.quote),
  }));

  // Process characters
  const characterMentions: CharacterMention[] = (raw.characters ?? []).map((c) => ({
    characterId: '', // Will be assigned in aggregation pass
    name: c.name,
    role: c.role,
    location: findLocation(c.quote),
    attributesMentioned: (c.attributes ?? []).map((a) => `${a.attribute}: ${a.value}`),
  }));

  // Process facts
  const facts: FactExtraction[] = (raw.facts ?? []).map((f, idx) => ({
    id: `${chunk.id}-fact-${idx}`,
    content: f.content,
    category: f.category as FactExtraction['category'],
    subject: f.subject,
    location: findLocation(f.quote),
  }));

  // Process plot threads
  const plotThreads: PlotThreadTouch[] = (raw.plotThreads ?? []).map((pt) => ({
    threadId: '', // Will be assigned in aggregation pass
    action: pt.action,
    description: pt.description,
    location: findLocation(pt.quote),
  }));

  // Process setups
  const setups: SetupExtraction[] = (raw.setups ?? []).map((s, idx) => ({
    id: `${chunk.id}-setup-${idx}`,
    description: s.description,
    weight: s.weight,
    impliedPayoff: s.impliedPayoff,
    location: findLocation(s.quote),
    status: 'pending' as const,
  }));

  return {
    events,
    characterMentions,
    facts,
    plotThreads,
    setups,
    openQuestions: raw.openQuestions ?? [],
  };
}

/**
 * Find the location of a quote in the chunk text
 */
function findTextLocation(
  quote: string,
  chunkText: string,
  chunkId: string
): TextLocation {
  // Try exact match first
  let startOffset = chunkText.indexOf(quote);

  // If not found, try case-insensitive
  if (startOffset === -1) {
    startOffset = chunkText.toLowerCase().indexOf(quote.toLowerCase());
  }

  // If still not found, try fuzzy match (find best substring match)
  if (startOffset === -1) {
    startOffset = fuzzyFindQuote(quote, chunkText);
  }

  // If we found it
  if (startOffset !== -1) {
    const endOffset = startOffset + quote.length;
    return {
      chunkId,
      startOffset,
      endOffset,
      snippet: chunkText.slice(startOffset, Math.min(endOffset, startOffset + 100)),
      humanReadable: getHumanReadableLocation(chunkText, startOffset),
    };
  }

  // Fallback: return beginning of chunk with the quote as snippet
  return {
    chunkId,
    startOffset: 0,
    endOffset: Math.min(quote.length, chunkText.length),
    snippet: quote.slice(0, 100),
    humanReadable: 'Location approximate',
  };
}

/**
 * Fuzzy find a quote in text (handles minor transcription differences)
 */
function fuzzyFindQuote(quote: string, text: string): number {
  // Normalize both strings
  const normalizeForSearch = (s: string) =>
    s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

  const normalizedQuote = normalizeForSearch(quote);
  const normalizedText = normalizeForSearch(text);

  // Try to find normalized version
  const normalizedIdx = normalizedText.indexOf(normalizedQuote);
  if (normalizedIdx !== -1) {
    // Map back to original text position (approximate)
    const ratio = normalizedIdx / normalizedText.length;
    return Math.floor(ratio * text.length);
  }

  // Try finding first few words
  const words = normalizedQuote.split(' ').slice(0, 5).join(' ');
  if (words.length > 10) {
    const wordIdx = normalizedText.indexOf(words);
    if (wordIdx !== -1) {
      const ratio = wordIdx / normalizedText.length;
      return Math.floor(ratio * text.length);
    }
  }

  return -1;
}

/**
 * Get human-readable location (e.g., "paragraph 3")
 */
function getHumanReadableLocation(text: string, offset: number): string {
  const beforeOffset = text.slice(0, offset);
  const paragraphs = beforeOffset.split(/\n\n+/);
  return `Paragraph ${paragraphs.length}`;
}

/**
 * Parse JSON from Claude's response
 */
function parseJsonFromResponse(text: string): Record<string, unknown> {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Fall through
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through
    }
  }

  console.error('Failed to parse JSON from response:', text.slice(0, 500));
  return {};
}
