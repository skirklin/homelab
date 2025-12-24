/**
 * Literary Critic Agent
 *
 * An agentic analyzer that reasons over extracted data to find
 * higher-level issues and provide insights about the manuscript.
 *
 * Uses a tool-calling loop to:
 * 1. Query the extracted "database" (characters, events, facts)
 * 2. Read source text when needed for deeper investigation
 * 3. Report insights and potential issues
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisOutput } from './output-schema.js';
import { criticToolDefinitions, CriticToolExecutor, type CriticInsight } from './critic-tools.js';

export interface CriticOptions {
  apiKey?: string;
  model?: string;
  /** Maximum iterations for the agent loop */
  maxIterations?: number;
  /** Areas to focus on (if not specified, all areas are analyzed) */
  focusAreas?: CriticFocusArea[];
  /** Callback for progress updates */
  onProgress?: (update: CriticProgress) => void;
}

export type CriticFocusArea =
  | 'continuity'
  | 'character_development'
  | 'plot_structure'
  | 'pacing'
  | 'themes'
  | 'dialogue'
  | 'world_building';

export interface CriticProgress {
  phase: 'starting' | 'investigating' | 'reporting' | 'complete';
  iteration: number;
  maxIterations: number;
  currentActivity?: string;
  insightsFound: number;
}

export interface CriticResult {
  insights: CriticInsight[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  iterations: number;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Build the system prompt for the literary critic
 */
function buildSystemPrompt(focusAreas?: CriticFocusArea[]): string {
  const focusSection = focusAreas?.length
    ? `\n\n## Focus Areas\nPay special attention to these aspects:\n${focusAreas.map(a => `- ${formatFocusArea(a)}`).join('\n')}`
    : '';

  return `You are an experienced literary critic and editor analyzing a novel manuscript. You have access to a database of extracted information about the manuscript, including characters, events, facts, and plot threads.

Your goal is to identify:
1. **Continuity Issues**: Contradictions in facts, timeline inconsistencies, character behavior that doesn't match established traits
2. **Character Development Problems**: Flat arcs, inconsistent motivations, dropped character threads
3. **Plot Holes**: Missing explanations, abandoned setups, logical inconsistencies
4. **Pacing Concerns**: Rushed sections, overly slow areas, imbalanced focus
5. **Structural Issues**: Weak openings, unsatisfying resolutions, thematic inconsistencies
6. **Strengths**: What the author does well - this is equally important!
7. **Suggestions**: Constructive feedback for improvement

## Working Method
1. Start by getting a document overview to understand the scope
2. Review existing issues that have been automatically detected
3. Investigate characters, especially major ones with high mention counts
4. Trace plot threads and check for proper resolution
5. Look for patterns across the narrative
6. When you find something concerning, read the actual text to verify
7. Report your insights using the report_insight tool

## Guidelines
- Be thorough but efficient - focus on significant issues
- Always verify hunches by reading the source text
- Consider the author's likely intent before criticizing
- Balance criticism with recognition of strengths
- Provide actionable, specific feedback
- Use evidence from the text to support your observations${focusSection}

When you have completed your analysis, indicate that you're done.`;
}

function formatFocusArea(area: CriticFocusArea): string {
  const descriptions: Record<CriticFocusArea, string> = {
    continuity: 'Continuity and consistency of facts, timeline, and character details',
    character_development: 'Character arcs, motivations, and development throughout the story',
    plot_structure: 'Plot coherence, thread resolution, and narrative logic',
    pacing: 'Story pacing, tension building, and scene balance',
    themes: 'Thematic consistency and development',
    dialogue: 'Dialogue authenticity and character voice',
    world_building: 'World-building consistency and depth',
  };
  return descriptions[area];
}

/**
 * Run the literary critic agent on analyzed data
 */
export async function runCritic(
  analysis: AnalysisOutput,
  options: CriticOptions = {}
): Promise<CriticResult> {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const client = new Anthropic({ apiKey });
  const model = options.model || DEFAULT_MODEL;
  const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;

  const executor = new CriticToolExecutor(analysis);
  const systemPrompt = buildSystemPrompt(options.focusAreas);

  // Initialize conversation
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Please analyze this manuscript. The systematic extraction has already identified ${analysis.summary.issueCount} potential issues. Your job is to investigate deeper, verify these issues, and find additional insights that the automated analysis might have missed.

Key statistics:
- ${analysis.summary.characterCount} characters
- ${analysis.summary.eventCount} events
- ${analysis.summary.plotThreadCount} plot threads (${analysis.summary.unresolvedThreadCount} unresolved)
- ${analysis.summary.issueCount} automatically detected issues

Start by getting an overview, then investigate systematically.`,
    },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let iteration = 0;
  let done = false;

  options.onProgress?.({
    phase: 'starting',
    iteration: 0,
    maxIterations,
    insightsFound: 0,
  });

  while (!done && iteration < maxIterations) {
    iteration++;

    options.onProgress?.({
      phase: 'investigating',
      iteration,
      maxIterations,
      insightsFound: executor.getInsights().length,
    });

    // Call the model
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: criticToolDefinitions,
      messages,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // Process response
    const assistantContent: Anthropic.ContentBlock[] = [];
    let hasToolUse = false;

    for (const block of response.content) {
      assistantContent.push(block);

      if (block.type === 'tool_use') {
        hasToolUse = true;
      }
    }

    // Add assistant message
    messages.push({
      role: 'assistant',
      content: assistantContent,
    });

    // If there are tool calls, execute them and add results
    if (hasToolUse) {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          options.onProgress?.({
            phase: 'investigating',
            iteration,
            maxIterations,
            currentActivity: `Using ${block.name}`,
            insightsFound: executor.getInsights().length,
          });

          const result = executor.execute(block.name, block.input as Record<string, unknown>);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    // Check if done
    if (response.stop_reason === 'end_turn' && !hasToolUse) {
      done = true;
    }

    // Also check if the assistant explicitly says they're done
    for (const block of response.content) {
      if (block.type === 'text') {
        const text = block.text.toLowerCase();
        if (
          text.includes('completed my analysis') ||
          text.includes('analysis is complete') ||
          text.includes('finished my review') ||
          text.includes("i'm done") ||
          text.includes('that concludes')
        ) {
          done = true;
        }
      }
    }
  }

  options.onProgress?.({
    phase: 'complete',
    iteration,
    maxIterations,
    insightsFound: executor.getInsights().length,
  });

  return {
    insights: executor.getInsights(),
    tokenUsage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
    iterations: iteration,
  };
}

/**
 * Critic insight converted to an issue-like object for display
 * This is a simplified version that doesn't require full TextLocation
 */
export interface CriticIssue {
  id: string;
  type: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  chunkIds: string[];
  evidence: Array<{
    quote: string;
    chunkId: string;
    note?: string;
  }>;
  relatedEntityIds: string[];
  status: 'open';
  source: 'critic';
}

/**
 * Convert critic insights to issue-like objects for display
 */
export function insightsToIssues(
  insights: CriticInsight[],
  startingId: number = 1000
): CriticIssue[] {
  return insights.map((insight, idx) => {
    // Map insight severity to issue severity
    const severityMap: Record<CriticInsight['severity'], 'error' | 'warning' | 'info'> = {
      critical: 'error',
      important: 'warning',
      minor: 'info',
      observation: 'info',
    };

    // Map insight type to issue type
    const typeMap: Record<CriticInsight['type'], string> = {
      continuity_issue: 'continuity_error',
      character_arc_observation: 'character_inconsistency',
      plot_hole: 'unresolved_thread',
      pacing_concern: 'pacing_issue',
      thematic_insight: 'thematic_observation',
      structural_observation: 'structural_issue',
      strength: 'strength',
      suggestion: 'suggestion',
    };

    return {
      id: `critic-${startingId + idx}`,
      type: typeMap[insight.type],
      severity: severityMap[insight.severity],
      title: insight.title,
      description: insight.description,
      chunkIds: insight.evidence
        .filter(e => e.chunk_id)
        .map(e => e.chunk_id!),
      evidence: insight.evidence
        .filter(e => e.quote && e.chunk_id)
        .map(e => ({
          quote: e.quote!,
          chunkId: e.chunk_id!,
          note: e.note,
        })),
      relatedEntityIds: insight.relatedEntityIds,
      status: 'open' as const,
      source: 'critic' as const,
    };
  });
}
