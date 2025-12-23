/**
 * Analyzer - finds issues across extracted chunk data
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ChunkExtraction, AnalysisResult, Issue } from './types.js';

export interface AnalyzerOptions {
  /** Anthropic API key */
  apiKey?: string;
  /** Model to use */
  model?: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

const ANALYSIS_PROMPT = `You are a manuscript analyst checking for continuity errors, plot holes, and other issues in a novel.

You will receive structured extraction data from each section of the manuscript. Analyze this data to find:

1. **Timeline Inconsistencies**: Events that can't happen in the order or timing described
2. **Character Inconsistencies**: Physical details, personality traits, or facts about characters that contradict each other
3. **Fact Contradictions**: World-building details, locations, or object descriptions that conflict
4. **Unresolved Plot Threads**: Story threads that were introduced but never resolved
5. **Orphaned Payoffs**: Resolutions or revelations that weren't properly set up
6. **Missing Setups**: Payoffs that happen without adequate foreshadowing
7. **Over-foreshadowed**: Setups that are so heavy-handed they telegraph the payoff
8. **Under-foreshadowed**: Major events that needed more setup
9. **Dropped Characters**: Characters who appear and then vanish without explanation
10. **Continuity Errors**: Any other logical inconsistencies

Return your findings as JSON:

{
  "issues": [
    {
      "type": "timeline_inconsistency|character_inconsistency|fact_contradiction|unresolved_thread|orphaned_payoff|missing_setup|over_foreshadowed|under_foreshadowed|dropped_character|continuity_error",
      "severity": "error|warning|info",
      "title": "Brief title for the issue",
      "description": "Detailed explanation of the problem",
      "chunkIds": ["chunk-1", "chunk-3"],
      "evidence": ["Quote or reference 1", "Quote or reference 2"]
    }
  ]
}

Be thorough. Writers need to catch these issues before publication. Include specific quotes or references as evidence.`;

/**
 * Analyze extracted data to find issues
 */
export async function analyzeExtractions(
  extractions: ChunkExtraction[],
  options: AnalyzerOptions = {}
): Promise<AnalysisResult> {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const client = new Anthropic({ apiKey });
  const model = options.model || DEFAULT_MODEL;

  // Prepare the extraction data for analysis
  const extractionSummary = formatExtractionsForAnalysis(extractions);

  // Call Claude to analyze
  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `${ANALYSIS_PROMPT}\n\n---\n\nEXTRACTED DATA:\n\n${extractionSummary}`,
      },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const parsed = parseJsonFromResponse(text) as { issues?: Issue[] };
  const issues: Issue[] = parsed.issues ?? [];

  // Also run heuristic checks that don't need AI
  const heuristicIssues = runHeuristicChecks(extractions);
  const allIssues = deduplicateIssues([...issues, ...heuristicIssues]);

  // Build summary
  const allCharacters = new Set<string>();
  const allThreads = new Set<string>();
  let unresolvedCount = 0;

  for (const ext of extractions) {
    for (const char of ext.characters) {
      allCharacters.add(char.name.toLowerCase());
    }
    for (const thread of ext.plotThreads) {
      allThreads.add(thread.name.toLowerCase());
      if (thread.status === 'introduced') {
        unresolvedCount++;
      } else if (thread.status === 'resolved') {
        unresolvedCount--;
      }
    }
  }

  return {
    chunks: extractions,
    issues: allIssues,
    summary: {
      totalChunks: extractions.length,
      totalCharacters: allCharacters.size,
      totalPlotThreads: allThreads.size,
      unresolvedThreads: Math.max(0, unresolvedCount),
      timelineEvents: extractions.reduce((n, e) => n + e.timelineEvents.length, 0),
      issueCount: allIssues.length,
    },
  };
}

/**
 * Format extractions for the analysis prompt
 */
function formatExtractionsForAnalysis(extractions: ChunkExtraction[]): string {
  return extractions.map((ext) => {
    const parts = [`## ${ext.chunkId}`];

    if (ext.timelineEvents.length > 0) {
      parts.push('\n### Timeline Events');
      for (const event of ext.timelineEvents) {
        parts.push(`- [${event.precision}] "${event.timeMarker}": ${event.description} (${event.characters.join(', ')})`);
      }
    }

    if (ext.characters.length > 0) {
      parts.push('\n### Characters');
      for (const char of ext.characters) {
        const details = char.details.length > 0 ? `: ${char.details.join('; ')}` : '';
        parts.push(`- ${char.name} (${char.role})${details}`);
      }
    }

    if (ext.factsEstablished.length > 0) {
      parts.push('\n### Facts Established');
      for (const fact of ext.factsEstablished) {
        parts.push(`- [${fact.category}] ${fact.subject}: ${fact.content}`);
      }
    }

    if (ext.plotThreads.length > 0) {
      parts.push('\n### Plot Threads');
      for (const thread of ext.plotThreads) {
        parts.push(`- [${thread.status}] ${thread.name}: ${thread.details}`);
      }
    }

    if (ext.setups.length > 0) {
      parts.push('\n### Setups/Foreshadowing');
      for (const setup of ext.setups) {
        parts.push(`- [${setup.weight}] ${setup.description} → ${setup.impliedPayoff}`);
      }
    }

    if (ext.openQuestions.length > 0) {
      parts.push('\n### Open Questions');
      for (const q of ext.openQuestions) {
        parts.push(`- ${q}`);
      }
    }

    return parts.join('\n');
  }).join('\n\n---\n\n');
}

/**
 * Run simple heuristic checks that don't need AI
 */
function runHeuristicChecks(extractions: ChunkExtraction[]): Issue[] {
  const issues: Issue[] = [];

  // Track plot threads
  const threadStatus = new Map<string, { introduced: string; resolved: string | null }>();

  for (const ext of extractions) {
    for (const thread of ext.plotThreads) {
      const key = thread.name.toLowerCase();

      if (thread.status === 'introduced') {
        if (!threadStatus.has(key)) {
          threadStatus.set(key, { introduced: ext.chunkId, resolved: null });
        }
      } else if (thread.status === 'resolved') {
        const existing = threadStatus.get(key);
        if (existing) {
          existing.resolved = ext.chunkId;
        } else {
          // Resolved without introduction
          issues.push({
            type: 'orphaned_payoff',
            severity: 'warning',
            title: `Orphaned resolution: "${thread.name}"`,
            description: `Plot thread "${thread.name}" appears to be resolved without being properly introduced.`,
            chunkIds: [ext.chunkId],
            evidence: [thread.details],
          });
        }
      }
    }
  }

  // Find unresolved threads
  for (const [name, status] of threadStatus) {
    if (status.resolved === null) {
      issues.push({
        type: 'unresolved_thread',
        severity: 'warning',
        title: `Unresolved plot thread: "${name}"`,
        description: `Plot thread "${name}" was introduced but never resolved.`,
        chunkIds: [status.introduced],
        evidence: [],
      });
    }
  }

  // Track character appearances for "dropped character" detection
  const characterAppearances = new Map<string, string[]>();

  for (const ext of extractions) {
    for (const char of ext.characters) {
      if (char.role === 'present') {
        const key = char.name.toLowerCase();
        if (!characterAppearances.has(key)) {
          characterAppearances.set(key, []);
        }
        characterAppearances.get(key)!.push(ext.chunkId);
      }
    }
  }

  // Characters who appear once early and never again might be dropped
  const chunkIds = extractions.map(e => e.chunkId);
  for (const [name, appearances] of characterAppearances) {
    if (appearances.length === 1) {
      const chunkIndex = chunkIds.indexOf(appearances[0]);
      // Only flag if they appeared in first half and never again
      if (chunkIndex >= 0 && chunkIndex < chunkIds.length / 2) {
        issues.push({
          type: 'dropped_character',
          severity: 'info',
          title: `Potentially dropped character: "${name}"`,
          description: `Character "${name}" appears in ${appearances[0]} and is never seen again.`,
          chunkIds: appearances,
          evidence: [],
        });
      }
    }
  }

  return issues;
}

/**
 * Remove duplicate issues
 */
function deduplicateIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.type}:${issue.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  console.error('Failed to parse JSON from analysis response');
  return { issues: [] };
}
