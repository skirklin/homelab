/**
 * Extractor - Captures source text locations for frontend highlighting
 *
 * This is the second pass of extraction, after discovery has identified
 * all characters and plot threads in the document.
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
import type { DiscoveredEntities } from './discovery.js';
import { formatDiscoveredContext } from './discovery.js';

import { AnalysisCache, hashDiscoveredEntities } from './cache.js';

export interface ExtractorOptions {
  apiKey?: string;
  model?: string;
  concurrency?: number;
  /** Pre-discovered entities to provide as context */
  discoveredEntities?: DiscoveredEntities;
  /** Cache instance for storing/retrieving extraction results */
  cache?: AnalysisCache;
  onProgress?: (completed: number, total: number, chunkId: string) => void;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Build the extraction prompt, optionally with discovered entity context
 */
function buildExtractionPrompt(discoveredContext?: string): string {
  const contextSection = discoveredContext
    ? `\n# DOCUMENT CONTEXT\nThe following characters and plot threads have been identified in this manuscript. Use these as reference when extracting:\n\n${discoveredContext}\n\n---\n`
    : '';

  const characterInstructions = discoveredContext
    ? `For each character that appears or is mentioned (use the known character names when matching):
- name: Character's name (use the canonical name from the known characters list if they match)
- role: "present" (in the scene), "mentioned" (talked about), or "flashback"
- attributes: Array of physical/personality details, each as a string like "blue eyes", "tall", "nervous demeanor"
- relationships: Array of relationships FROM THIS CHARACTER'S PERSPECTIVE revealed in this section. Format: {target: "other character name", relationship: "what the target is TO this character"}
  IMPORTANT: The relationship describes what the TARGET is to the SOURCE character.
  Examples: If Alice's mother is named Beth, Alice's relationship entry is {target: "Beth", relationship: "mother"} (Beth is Alice's mother).
  If Bob employs Carol, Carol's relationship entry is {target: "Bob", relationship: "employer"} (Bob is Carol's employer).
- quote: A quote showing their appearance/mention`
    : `For each character that appears or is mentioned:
- name: Character's name
- role: "present" (in the scene), "mentioned" (talked about), or "flashback"
- attributes: Array of physical/personality details, each as a string like "blue eyes", "tall", "nervous demeanor"
- relationships: Array of relationships FROM THIS CHARACTER'S PERSPECTIVE revealed in this section. Format: {target: "other character name", relationship: "what the target is TO this character"}
  IMPORTANT: The relationship describes what the TARGET is to the SOURCE character.
  Examples: If Alice's mother is named Beth, Alice's relationship entry is {target: "Beth", relationship: "mother"} (Beth is Alice's mother).
  If Bob employs Carol, Carol's relationship entry is {target: "Bob", relationship: "employer"} (Bob is Carol's employer).
- quote: A quote showing their appearance/mention`;

  const threadInstructions = discoveredContext
    ? `Story threads touched in this section. Match to known threads when possible. A thread is resolved when its central question/conflict is answered/concluded.
- name: Use the exact name from the known plot threads list if this section touches that thread
- action: "introduced" (new thread), "advanced" (progress made), "complicated" (new obstacle/twist), or "resolved" (concluded - the central question is answered)
- description: What happened with this thread in this section
- quote: Relevant quote`
    : `Story threads touched in this section. A thread is resolved when its central question/conflict is answered/concluded (e.g., a mystery is solved, a goal is achieved, a relationship reaches a conclusion).
- name: Brief name for the thread (e.g., "Emma Hartley murder investigation", "Sarah and Marcus romance")
- action: "introduced" (new thread), "advanced" (progress made), "complicated" (new obstacle/twist), or "resolved" (concluded)
- description: What happened with this thread
- quote: Relevant quote`;

  return `You are analyzing a section of a novel manuscript. Extract structured information with EXACT QUOTES from the text.
${contextSection}
For each item you extract, you MUST include:
1. The exact quote from the text (verbatim, word-for-word)
2. This quote will be used to locate the text in the original document, so accuracy is critical

Analyze the text and extract:

## 1. Events (things that happen)
For each significant event:
- description: What happened
- timeMarker: Quote ANY time reference from the text. Look for:
  * Explicit times: "Monday morning", "3pm", "January 5th"
  * Relative times: "three days later", "the next morning", "after dinner"
  * Vague times: "that evening", "later", "soon after"
  * Scene context: "during the meeting", "while driving home"
  * If truly no time reference, use "continuing" (same scene as previous) or "scene break" (new scene, time unclear)
- precision: "exact" (specific date/time), "relative" (e.g., "three days later"), or "vague" (e.g., "that morning")
- sequenceNote: What narrative context surrounds this? (e.g., "after the argument", "before discovering the body", "same conversation as previous event")
- characters: Names of characters involved (use canonical names from known characters if applicable)
- quote: The EXACT sentence(s) describing this event

## 2. Character Appearances
${characterInstructions}

## 3. Facts Established
Concrete details that could be contradicted later:
- content: The fact
- category: "character", "world", "location", "object", "relationship", or "other"
- subject: What/who it's about
- quote: EXACT quote establishing this fact

## 4. Plot Threads
${threadInstructions}

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
}

export interface ExtractionResult {
  chunks: ChunkWithText[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface ChunkExtractionResult {
  chunk: ChunkWithText;
  inputTokens: number;
  outputTokens: number;
}

interface RawExtraction {
  events?: Array<{
    description: string;
    timeMarker: string;
    precision: 'exact' | 'relative' | 'vague';
    sequenceNote?: string;
    characters: string[];
    quote: string;
  }>;
  characters?: Array<{
    name: string;
    role: 'present' | 'mentioned' | 'flashback';
    attributes?: Array<string | Record<string, unknown>>;
    relationships?: Array<{
      target: string;
      relationship: string;
    }>;
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
    action: 'introduced' | 'advanced' | 'complicated' | 'resolved';
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
export async function extractFromChunks(
  chunks: Chunk[],
  options: ExtractorOptions = {}
): Promise<ExtractionResult> {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const client = new Anthropic({ apiKey });
  const model = options.model || DEFAULT_MODEL;
  const concurrency = options.concurrency || 3;
  const cache = options.cache;

  // Build extraction prompt with discovered context if available
  const discoveredContext = options.discoveredEntities
    ? formatDiscoveredContext(options.discoveredEntities)
    : undefined;
  const extractionPrompt = buildExtractionPrompt(discoveredContext);

  // Hash of discovered entities for cache key
  const entitiesHash = options.discoveredEntities
    ? hashDiscoveredEntities(options.discoveredEntities)
    : '';

  const allResults: ChunkExtractionResult[] = [];
  let completed = 0;

  // Track character offset across chunks
  let currentOffset = 0;

  // Separate chunks into cached and uncached
  const uncachedChunks: Array<{ chunk: Chunk; offset: number; index: number }> = [];
  const chunkOffsets: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const offset = currentOffset;
    currentOffset += chunk.content.length + 1;
    chunkOffsets.push(offset);

    // Check cache
    if (cache) {
      const cached = cache.getExtraction(chunk.content, chunk.id, model, entitiesHash);
      if (cached) {
        allResults[i] = {
          chunk: {
            id: chunk.id,
            title: chunk.title,
            text: chunk.content,
            startOffset: offset,
            endOffset: offset + chunk.content.length,
            extraction: cached.extraction,
          },
          inputTokens: cached.tokenUsage.inputTokens,
          outputTokens: cached.tokenUsage.outputTokens,
        };
        completed++;
        options.onProgress?.(completed, chunks.length, chunk.id);
        continue;
      }
    }

    uncachedChunks.push({ chunk, offset, index: i });
  }

  if (uncachedChunks.length > 0) {
    console.log(`[Extractor] Processing ${uncachedChunks.length} uncached chunks (${chunks.length - uncachedChunks.length} from cache)`);
  }

  // Process uncached chunks in batches
  for (let i = 0; i < uncachedChunks.length; i += concurrency) {
    const batch = uncachedChunks.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async ({ chunk, offset, index }) => {
        const result = await extractFromChunk(
          client,
          model,
          chunk,
          offset,
          extractionPrompt
        );

        // Save to cache
        if (cache) {
          cache.setExtraction(
            chunk.content,
            model,
            entitiesHash,
            result.chunk.extraction,
            { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
          );
        }

        completed++;
        options.onProgress?.(completed, chunks.length, chunk.id);
        return { result, index };
      })
    );

    // Insert results at correct positions
    for (const { result, index } of batchResults) {
      allResults[index] = result;
    }
  }

  // Aggregate token usage
  const tokenUsage = {
    inputTokens: allResults.reduce((sum, r) => sum + r.inputTokens, 0),
    outputTokens: allResults.reduce((sum, r) => sum + r.outputTokens, 0),
  };

  return {
    chunks: allResults.map(r => r.chunk),
    tokenUsage,
  };
}

/**
 * Extract from a single chunk with location tracking
 */
async function extractFromChunk(
  client: Anthropic,
  model: string,
  chunk: Chunk,
  startOffset: number,
  extractionPrompt: string
): Promise<ChunkExtractionResult> {
  const chunkContext = chunk.title
    ? `## Section: ${chunk.title}\n\n${chunk.content}`
    : chunk.content;

  // Use streaming for long requests
  const stream = client.messages.stream({
    model,
    max_tokens: 64000,
    messages: [
      {
        role: 'user',
        content: `${extractionPrompt}\n\n---\n\nTEXT TO ANALYZE:\n\n${chunkContext}`,
      },
    ],
  });

  const response = await stream.finalMessage();

  // Check if response was truncated
  if (response.stop_reason === 'max_tokens') {
    console.warn(`Warning: Extraction for chunk ${chunk.id} was truncated - response hit token limit`);
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const raw = parseJsonFromResponse(text, chunk.id) as RawExtraction;

  // Convert raw extraction to typed extraction with locations
  const extraction = processRawExtraction(raw, chunk);

  return {
    chunk: {
      id: chunk.id,
      title: chunk.title,
      text: chunk.content,
      startOffset,
      endOffset: startOffset + chunk.content.length,
      extraction,
    },
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
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
    sequenceNote: e.sequenceNote,
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
    attributesMentioned: (c.attributes ?? []).map((a) => {
      // Handle various formats Claude might return
      if (typeof a === 'string') {
        return a; // Already a string like "blue eyes"
      }
      if (a && typeof a === 'object') {
        const obj = a as Record<string, unknown>;
        // Try different field name combinations
        const attr = String(obj.attribute || obj.name || obj.trait || obj.type || '');
        const val = String(obj.value || obj.detail || obj.description || '');
        if (attr && val) {
          return `${attr}: ${val}`;
        }
        // If only one field exists, use it as the full description
        return attr || val || JSON.stringify(a);
      }
      return String(a);
    }).filter(Boolean),
    relationshipsMentioned: (c.relationships ?? []).map((r) => ({
      target: r.target,
      relationship: r.relationship,
    })),
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
    name: pt.name,
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
      snippet: chunkText.slice(startOffset, endOffset),
      humanReadable: getHumanReadableLocation(chunkText, startOffset),
    };
  }

  // Fallback: return beginning of chunk with the quote as snippet
  return {
    chunkId,
    startOffset: 0,
    endOffset: Math.min(quote.length, chunkText.length),
    snippet: quote,
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
function parseJsonFromResponse(text: string, chunkId?: string): Record<string, unknown> {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      console.error(`JSON parse error in code block for ${chunkId || 'unknown chunk'}:`, e);
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error(`JSON parse error for ${chunkId || 'unknown chunk'}:`, e);
      console.error('JSON snippet:', jsonMatch[0].slice(0, 200), '...', jsonMatch[0].slice(-200));
    }
  }

  console.error(`Failed to extract JSON from response for ${chunkId || 'unknown chunk'}. Response start:`, text.slice(0, 500));
  return {};
}
