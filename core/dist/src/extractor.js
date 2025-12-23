/**
 * Extractor - uses Claude API to extract structured data from text chunks
 */
import Anthropic from '@anthropic-ai/sdk';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const EXTRACTION_PROMPT = `You are analyzing a section of a novel manuscript. Extract structured information that will be used to check for continuity errors, plot holes, and other issues.

Analyze the text carefully and extract:

1. **Timeline Events**: Any events that happen, with time markers if mentioned (exact dates, relative times like "three days later", or vague like "that morning")

2. **Characters**: Who appears or is mentioned, with any physical or personality details given

3. **Facts Established**: Concrete details about characters, the world, locations, or objects that could be contradicted later

4. **Plot Threads**: Story threads that are introduced, advanced, or resolved in this section

5. **Setups/Foreshadowing**: Things mentioned that seem to promise future payoff (Chekhov's guns, hints, prophecies, etc.)

6. **Open Questions**: Mysteries or tensions raised for the reader

Return your analysis as JSON matching this schema:

{
  "timelineEvents": [
    {
      "description": "what happened",
      "timeMarker": "when (quote from text or inferred)",
      "precision": "exact|relative|vague",
      "characters": ["names involved"]
    }
  ],
  "characters": [
    {
      "name": "character name",
      "details": ["physical/personality details mentioned"],
      "role": "present|mentioned|flashback"
    }
  ],
  "factsEstablished": [
    {
      "content": "the fact",
      "category": "character|world|location|object|relationship|other",
      "subject": "what/who it's about"
    }
  ],
  "plotThreads": [
    {
      "name": "thread name",
      "status": "introduced|advanced|resolved",
      "details": "what happened with this thread"
    }
  ],
  "setups": [
    {
      "description": "what was set up",
      "weight": "subtle|moderate|heavy",
      "impliedPayoff": "what this seems to promise"
    }
  ],
  "openQuestions": ["questions raised for the reader"]
}

Be thorough but precise. Only include information that is actually present in the text.`;
/**
 * Extract structured information from chunks using Claude API
 */
export async function extractFromChunks(chunks, options = {}) {
    const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is required');
    }
    const client = new Anthropic({ apiKey });
    const model = options.model || DEFAULT_MODEL;
    const concurrency = options.concurrency || 3;
    const results = [];
    let completed = 0;
    // Process in batches for concurrency control
    for (let i = 0; i < chunks.length; i += concurrency) {
        const batch = chunks.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(async (chunk) => {
            const extraction = await extractFromChunk(client, model, chunk);
            completed++;
            options.onProgress?.(completed, chunks.length, chunk.id);
            return extraction;
        }));
        results.push(...batchResults);
    }
    return results;
}
/**
 * Extract from a single chunk
 */
async function extractFromChunk(client, model, chunk) {
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
    // Extract JSON from response
    const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    const parsed = parseJsonFromResponse(text);
    return {
        chunkId: chunk.id,
        timelineEvents: parsed.timelineEvents ?? [],
        characters: parsed.characters ?? [],
        factsEstablished: parsed.factsEstablished ?? [],
        plotThreads: parsed.plotThreads ?? [],
        setups: parsed.setups ?? [],
        openQuestions: parsed.openQuestions ?? [],
    };
}
/**
 * Parse JSON from Claude's response (handles markdown code blocks)
 */
function parseJsonFromResponse(text) {
    // Try to find JSON in code blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        try {
            return JSON.parse(codeBlockMatch[1].trim());
        }
        catch {
            // Fall through to other attempts
        }
    }
    // Try to find raw JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0]);
        }
        catch {
            // Fall through
        }
    }
    console.error('Failed to parse JSON from response:', text.slice(0, 500));
    return {};
}
/**
 * Extract from a single chunk (exported for individual use)
 */
export async function extractSingle(chunk, options = {}) {
    const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is required');
    }
    const client = new Anthropic({ apiKey });
    const model = options.model || DEFAULT_MODEL;
    return extractFromChunk(client, model, chunk);
}
//# sourceMappingURL=extractor.js.map