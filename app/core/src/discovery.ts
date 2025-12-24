/**
 * Discovery Pass - First pass to identify all entities across the document
 *
 * This quick pass identifies:
 * - All character names and aliases
 * - All plot threads
 * - Key locations
 *
 * This information is then provided as context to the detailed extraction pass.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Chunk } from './types.js';

export interface DiscoveryResult {
  entities: DiscoveredEntities;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface DiscoveredEntities {
  characters: DiscoveredCharacter[];
  plotThreads: DiscoveredThread[];
  locations: string[];
}

export interface DiscoveredCharacter {
  /** Primary name */
  name: string;
  /** Alternative names/references found */
  aliases: string[];
  /** Brief description if found */
  description?: string;
}

export interface DiscoveredThread {
  /** Brief name for the thread */
  name: string;
  /** What the thread is about */
  description: string;
  /** The central question/conflict */
  centralQuestion?: string;
}

export interface DiscoveryOptions {
  apiKey?: string;
  model?: string;
  onProgress?: (completed: number, total: number) => void;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

const DISCOVERY_PROMPT = `You are analyzing a novel manuscript to identify all characters and plot threads.

Scan the text and identify:

## Characters
List every character that appears or is mentioned. For each character:
- name: Their primary name (most formal/complete version)
- aliases: Other names they're called (nicknames, titles, first name only, etc.)
- description: Brief one-line description if apparent

## Plot Threads
Identify the main storylines/threads. A plot thread is a narrative arc with a central question or conflict. For each:
- name: Brief name (e.g., "Emma Hartley murder investigation")
- description: What the thread is about
- centralQuestion: The question driving this thread (e.g., "Who killed Emma Hartley?")

## Locations
List the main locations/settings mentioned.

Return as JSON:
{
  "characters": [
    {"name": "...", "aliases": ["...", "..."], "description": "..."}
  ],
  "plotThreads": [
    {"name": "...", "description": "...", "centralQuestion": "..."}
  ],
  "locations": ["...", "..."]
}

Focus on being comprehensive - it's better to include minor characters than miss important ones.`;

interface SegmentResult {
  entities: DiscoveredEntities;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Run discovery pass across all chunks to identify entities
 */
export async function discoverEntities(
  chunks: Chunk[],
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const client = new Anthropic({ apiKey });
  const model = options.model || DEFAULT_MODEL;

  // For discovery, we can process chunks in larger batches
  // Combine chunks into segments for efficiency
  const segmentSize = 5; // Process 5 chunks at a time
  const segments: string[] = [];

  for (let i = 0; i < chunks.length; i += segmentSize) {
    const segment = chunks
      .slice(i, i + segmentSize)
      .map(c => c.title ? `## ${c.title}\n\n${c.content}` : c.content)
      .join('\n\n---\n\n');
    segments.push(segment);
  }

  // Process segments in parallel with limited concurrency
  const concurrency = 3;
  const allResults: SegmentResult[] = [];
  let completed = 0;

  for (let i = 0; i < segments.length; i += concurrency) {
    const batch = segments.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (segment) => {
        const result = await discoverFromSegment(client, model, segment);
        completed++;
        options.onProgress?.(completed, segments.length);
        return result;
      })
    );
    allResults.push(...batchResults);
  }

  // Aggregate token usage
  const tokenUsage = {
    inputTokens: allResults.reduce((sum, r) => sum + r.inputTokens, 0),
    outputTokens: allResults.reduce((sum, r) => sum + r.outputTokens, 0),
  };

  // Merge all discoveries
  const entities = mergeDiscoveries(allResults.map(r => r.entities));

  return { entities, tokenUsage };
}

/**
 * Discover entities from a single segment
 */
async function discoverFromSegment(
  client: Anthropic,
  model: string,
  segment: string
): Promise<SegmentResult> {
  // Use streaming for long requests
  const stream = client.messages.stream({
    model,
    max_tokens: 16384,
    messages: [
      {
        role: 'user',
        content: `${DISCOVERY_PROMPT}\n\n---\n\nTEXT TO ANALYZE:\n\n${segment}`,
      },
    ],
  });

  const response = await stream.finalMessage();

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    entities: parseDiscoveryResponse(text),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * Parse the discovery response JSON
 */
function parseDiscoveryResponse(text: string): DiscoveredEntities {
  const empty: DiscoveredEntities = { characters: [], plotThreads: [], locations: [] };

  try {
    // Try to extract JSON from the response
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return { ...empty, ...JSON.parse(codeBlockMatch[1].trim()) };
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return { ...empty, ...JSON.parse(jsonMatch[0]) };
    }
  } catch (e) {
    console.error('Failed to parse discovery response:', e);
  }

  return empty;
}

/**
 * Merge multiple discovery results, deduplicating entities
 */
function mergeDiscoveries(results: DiscoveredEntities[]): DiscoveredEntities {
  const characterMap = new Map<string, DiscoveredCharacter>();
  const threadMap = new Map<string, DiscoveredThread>();
  const locationSet = new Set<string>();

  for (const result of results) {
    // Merge characters
    for (const char of result.characters) {
      const normalized = char.name.toLowerCase();
      const existing = findMatchingCharacter(char.name, characterMap);

      if (existing) {
        // Merge aliases
        const existingChar = characterMap.get(existing)!;
        for (const alias of char.aliases || []) {
          if (!existingChar.aliases.includes(alias) &&
              alias.toLowerCase() !== existingChar.name.toLowerCase()) {
            existingChar.aliases.push(alias);
          }
        }
        // Use longer description if available
        if (char.description && (!existingChar.description ||
            char.description.length > existingChar.description.length)) {
          existingChar.description = char.description;
        }
      } else {
        characterMap.set(normalized, {
          name: char.name,
          aliases: char.aliases || [],
          description: char.description,
        });
      }
    }

    // Merge plot threads
    for (const thread of result.plotThreads) {
      const existing = findMatchingThread(thread.name, threadMap);

      if (existing) {
        const existingThread = threadMap.get(existing)!;
        // Use longer description
        if (thread.description && thread.description.length > existingThread.description.length) {
          existingThread.description = thread.description;
        }
        if (thread.centralQuestion && !existingThread.centralQuestion) {
          existingThread.centralQuestion = thread.centralQuestion;
        }
      } else {
        threadMap.set(thread.name.toLowerCase(), thread);
      }
    }

    // Merge locations
    for (const loc of result.locations) {
      locationSet.add(loc);
    }
  }

  return {
    characters: Array.from(characterMap.values()),
    plotThreads: Array.from(threadMap.values()),
    locations: Array.from(locationSet),
  };
}

/**
 * Find a matching character in the map (handles name variants)
 */
function findMatchingCharacter(
  name: string,
  map: Map<string, DiscoveredCharacter>
): string | null {
  const normalized = name.toLowerCase();

  // Exact match
  if (map.has(normalized)) {
    return normalized;
  }

  // Check if name matches any aliases
  for (const [key, char] of map) {
    if (char.aliases.some(a => a.toLowerCase() === normalized)) {
      return key;
    }

    // Check partial name match (first/last name)
    const nameParts = normalized.split(/\s+/);
    const keyParts = key.split(/\s+/);

    if (nameParts.some(p => keyParts.includes(p) && p.length > 2)) {
      return key;
    }
  }

  return null;
}

/**
 * Find a matching thread in the map
 */
function findMatchingThread(
  name: string,
  map: Map<string, DiscoveredThread>
): string | null {
  const normalized = name.toLowerCase();

  if (map.has(normalized)) {
    return normalized;
  }

  // Check for significant word overlap
  const words = new Set(
    normalized.split(/\W+/).filter(w => w.length > 3)
  );

  for (const [key, thread] of map) {
    const keyWords = new Set(
      key.split(/\W+/).filter(w => w.length > 3)
    );

    let overlap = 0;
    for (const word of words) {
      if (keyWords.has(word)) overlap++;
    }

    if (overlap >= 2) {
      return key;
    }
  }

  return null;
}

/**
 * Format discovered entities for inclusion in extraction prompt
 */
export function formatDiscoveredContext(entities: DiscoveredEntities): string {
  const lines: string[] = [];

  lines.push('## Known Characters');
  lines.push('These characters have been identified in the manuscript. Match mentions to this list:');
  for (const char of entities.characters) {
    const aliases = char.aliases.length > 0 ? ` (also: ${char.aliases.join(', ')})` : '';
    const desc = char.description ? ` - ${char.description}` : '';
    lines.push(`- ${char.name}${aliases}${desc}`);
  }

  lines.push('');
  lines.push('## Known Plot Threads');
  lines.push('These are the main storylines. When you see these threads touched, identify if they are advanced, complicated, or resolved:');
  for (const thread of entities.plotThreads) {
    const question = thread.centralQuestion ? ` (Central question: ${thread.centralQuestion})` : '';
    lines.push(`- "${thread.name}": ${thread.description}${question}`);
  }

  if (entities.locations.length > 0) {
    lines.push('');
    lines.push('## Known Locations');
    lines.push(entities.locations.join(', '));
  }

  return lines.join('\n');
}
