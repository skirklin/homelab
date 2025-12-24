/**
 * Critic Tools - Tools available to the literary critic agent
 *
 * These tools allow the agent to query the extracted data "database"
 * and read source text for deeper investigation.
 */

import type {
  AnalysisOutput,
  CharacterEntity,
  ChunkWithText,
  EventExtraction,
  FactExtraction,
  PlotThreadView,
  IssueWithContext,
} from './output-schema.js';

/**
 * Tool definitions for the Claude API
 */
export const criticToolDefinitions = [
  {
    name: 'search_characters',
    description: 'Search for characters by name or attribute. Returns character IDs and basic info.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query - character name, alias, or attribute to search for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_character_details',
    description: 'Get detailed information about a specific character including attributes, relationships, and timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        character_id: {
          type: 'string',
          description: 'The character ID to look up',
        },
      },
      required: ['character_id'],
    },
  },
  {
    name: 'search_events',
    description: 'Search for events by description, time, or characters involved.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query - event description or keyword',
        },
        character_id: {
          type: 'string',
          description: 'Filter to events involving this character',
        },
        chunk_id: {
          type: 'string',
          description: 'Filter to events in this chunk',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_event_details',
    description: 'Get detailed information about a specific event including surrounding context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: {
          type: 'string',
          description: 'The event ID to look up',
        },
        include_context: {
          type: 'boolean',
          description: 'Whether to include surrounding text context (default: true)',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'search_facts',
    description: 'Search for established facts by content or subject.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query - fact content or subject',
        },
        category: {
          type: 'string',
          enum: ['character', 'world', 'location', 'object', 'relationship', 'other'],
          description: 'Filter by fact category',
        },
        subject: {
          type: 'string',
          description: 'Filter by subject (e.g., character name)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_plot_threads',
    description: 'Get all plot threads with their status and lifecycle.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'resolved', 'abandoned'],
          description: 'Filter by thread status',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_plot_thread_details',
    description: 'Get detailed information about a specific plot thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        thread_id: {
          type: 'string',
          description: 'The plot thread ID to look up',
        },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'read_chunk',
    description: 'Read the full text of a specific chunk/section of the manuscript.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chunk_id: {
          type: 'string',
          description: 'The chunk ID to read',
        },
      },
      required: ['chunk_id'],
    },
  },
  {
    name: 'read_text_at_location',
    description: 'Read text around a specific location in the manuscript.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chunk_id: {
          type: 'string',
          description: 'The chunk ID',
        },
        start_offset: {
          type: 'number',
          description: 'Start offset within the chunk',
        },
        end_offset: {
          type: 'number',
          description: 'End offset within the chunk',
        },
        context_chars: {
          type: 'number',
          description: 'Number of characters of context to include before/after (default: 200)',
        },
      },
      required: ['chunk_id', 'start_offset', 'end_offset'],
    },
  },
  {
    name: 'get_existing_issues',
    description: 'Get issues that have already been detected by the systematic analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Filter by issue type',
        },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'info'],
          description: 'Filter by severity',
        },
        character_id: {
          type: 'string',
          description: 'Filter to issues related to this character',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_document_overview',
    description: 'Get a high-level overview of the document structure and statistics.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'compare_character_timelines',
    description: 'Compare the event timelines of two characters to find overlaps and discrepancies.',
    input_schema: {
      type: 'object' as const,
      properties: {
        character_id_1: {
          type: 'string',
          description: 'First character ID',
        },
        character_id_2: {
          type: 'string',
          description: 'Second character ID',
        },
      },
      required: ['character_id_1', 'character_id_2'],
    },
  },
  {
    name: 'report_insight',
    description: 'Report an insight or potential issue found during analysis. Use this to record your findings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: [
            'continuity_issue',
            'character_arc_observation',
            'plot_hole',
            'pacing_concern',
            'thematic_insight',
            'structural_observation',
            'strength',
            'suggestion',
          ],
          description: 'Type of insight',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'important', 'minor', 'observation'],
          description: 'How significant is this finding',
        },
        title: {
          type: 'string',
          description: 'Brief title for the insight',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the insight',
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              chunk_id: { type: 'string' },
              quote: { type: 'string' },
              note: { type: 'string' },
            },
          },
          description: 'Evidence supporting this insight',
        },
        related_entity_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of characters, threads, etc. related to this insight',
        },
      },
      required: ['type', 'severity', 'title', 'description'],
    },
  },
];

/**
 * Tool executor - executes tools against the analysis data
 */
export class CriticToolExecutor {
  private analysis: AnalysisOutput;
  private chunks: Map<string, ChunkWithText>;
  private events: Map<string, { event: EventExtraction; chunk: ChunkWithText }>;
  private insights: CriticInsight[] = [];

  constructor(analysis: AnalysisOutput) {
    this.analysis = analysis;

    // Build lookup maps
    this.chunks = new Map();
    this.events = new Map();

    for (const chunk of analysis.chunks) {
      this.chunks.set(chunk.id, chunk);
      for (const event of chunk.extraction.events) {
        this.events.set(event.id, { event, chunk });
      }
    }
  }

  /**
   * Execute a tool and return the result
   */
  execute(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'search_characters':
        return this.searchCharacters(input);
      case 'get_character_details':
        return this.getCharacterDetails(input);
      case 'search_events':
        return this.searchEvents(input);
      case 'get_event_details':
        return this.getEventDetails(input);
      case 'search_facts':
        return this.searchFacts(input);
      case 'get_plot_threads':
        return this.getPlotThreads(input);
      case 'get_plot_thread_details':
        return this.getPlotThreadDetails(input);
      case 'read_chunk':
        return this.readChunk(input);
      case 'read_text_at_location':
        return this.readTextAtLocation(input);
      case 'get_existing_issues':
        return this.getExistingIssues(input);
      case 'get_document_overview':
        return this.getDocumentOverview();
      case 'compare_character_timelines':
        return this.compareCharacterTimelines(input);
      case 'report_insight':
        return this.reportInsight(input);
      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  }

  /**
   * Get all collected insights
   */
  getInsights(): CriticInsight[] {
    return this.insights;
  }

  private searchCharacters(input: Record<string, unknown>): string {
    const query = (input.query as string).toLowerCase();
    const limit = (input.limit as number) || 10;

    const results = this.analysis.entities.characters
      .filter(char => {
        const nameMatch = char.name.toLowerCase().includes(query);
        const aliasMatch = char.aliases.some(a => a.toLowerCase().includes(query));
        const attrMatch = char.attributes.some(
          a => a.attribute.toLowerCase().includes(query) ||
               a.value.toLowerCase().includes(query)
        );
        return nameMatch || aliasMatch || attrMatch;
      })
      .slice(0, limit)
      .map(char => ({
        id: char.id,
        name: char.name,
        aliases: char.aliases,
        totalMentions: char.stats.totalMentions,
        issueCount: char.issueIds.length,
      }));

    return JSON.stringify({ characters: results, total: results.length });
  }

  private getCharacterDetails(input: Record<string, unknown>): string {
    const charId = input.character_id as string;
    const char = this.analysis.entities.characters.find(c => c.id === charId);

    if (!char) {
      return JSON.stringify({ error: `Character not found: ${charId}` });
    }

    // Get character's events
    const events = char.eventIds
      .map(id => this.events.get(id))
      .filter(e => e)
      .map(e => ({
        id: e!.event.id,
        description: e!.event.description,
        timeMarker: e!.event.timeMarker,
        chunkId: e!.chunk.id,
        chunkTitle: e!.chunk.title,
      }));

    return JSON.stringify({
      id: char.id,
      name: char.name,
      aliases: char.aliases,
      attributes: char.attributes.map(a => ({
        attribute: a.attribute,
        value: a.value,
        hasConflict: !!a.conflictsWith,
        location: a.location.humanReadable,
      })),
      relationships: char.relationships.map(r => ({
        target: r.targetName,
        relationship: r.relationship,
        sharedEventCount: r.sharedEventIds.length,
      })),
      appearances: char.appearances.map(a => ({
        chunkId: a.chunkId,
        role: a.role,
        mentionCount: a.mentions.length,
      })),
      stats: char.stats,
      events,
      issueIds: char.issueIds,
    });
  }

  private searchEvents(input: Record<string, unknown>): string {
    const query = input.query as string | undefined;
    const characterId = input.character_id as string | undefined;
    const chunkId = input.chunk_id as string | undefined;
    const limit = (input.limit as number) || 20;

    let results: Array<{ event: EventExtraction; chunk: ChunkWithText }> = [];

    for (const chunk of this.analysis.chunks) {
      if (chunkId && chunk.id !== chunkId) continue;

      for (const event of chunk.extraction.events) {
        if (characterId && !event.characterIds.includes(characterId)) continue;
        if (query && !event.description.toLowerCase().includes(query.toLowerCase())) continue;

        results.push({ event, chunk });
      }
    }

    results = results.slice(0, limit);

    return JSON.stringify({
      events: results.map(({ event, chunk }) => ({
        id: event.id,
        description: event.description,
        timeMarker: event.timeMarker,
        precision: event.precision,
        characterIds: event.characterIds,
        chunkId: chunk.id,
        chunkTitle: chunk.title,
        snippet: event.location.snippet.slice(0, 150),
      })),
      total: results.length,
    });
  }

  private getEventDetails(input: Record<string, unknown>): string {
    const eventId = input.event_id as string;
    const includeContext = input.include_context !== false;

    const found = this.events.get(eventId);
    if (!found) {
      return JSON.stringify({ error: `Event not found: ${eventId}` });
    }

    const { event, chunk } = found;

    let context = '';
    if (includeContext) {
      const start = Math.max(0, event.location.startOffset - 200);
      const end = Math.min(chunk.text.length, event.location.endOffset + 200);
      context = chunk.text.slice(start, end);
    }

    // Find characters involved
    const characters = event.characterIds
      .map(id => this.analysis.entities.characters.find(c => c.id === id))
      .filter(c => c)
      .map(c => ({ id: c!.id, name: c!.name }));

    return JSON.stringify({
      id: event.id,
      description: event.description,
      timeMarker: event.timeMarker,
      precision: event.precision,
      characters,
      location: {
        chunkId: chunk.id,
        chunkTitle: chunk.title,
        humanReadable: event.location.humanReadable,
        snippet: event.location.snippet,
      },
      context: includeContext ? context : undefined,
    });
  }

  private searchFacts(input: Record<string, unknown>): string {
    const query = input.query as string | undefined;
    const category = input.category as string | undefined;
    const subject = input.subject as string | undefined;
    const limit = (input.limit as number) || 20;

    const results: Array<{ fact: FactExtraction; chunkId: string }> = [];

    for (const chunk of this.analysis.chunks) {
      for (const fact of chunk.extraction.facts) {
        if (category && fact.category !== category) continue;
        if (subject && !fact.subject.toLowerCase().includes(subject.toLowerCase())) continue;
        if (query && !fact.content.toLowerCase().includes(query.toLowerCase())) continue;

        results.push({ fact, chunkId: chunk.id });
      }
    }

    return JSON.stringify({
      facts: results.slice(0, limit).map(({ fact, chunkId }) => ({
        id: fact.id,
        content: fact.content,
        category: fact.category,
        subject: fact.subject,
        chunkId,
        hasContradiction: !!fact.contradicts,
      })),
      total: results.length,
    });
  }

  private getPlotThreads(input: Record<string, unknown>): string {
    const status = input.status as string | undefined;

    let threads = this.analysis.plotThreads;
    if (status) {
      threads = threads.filter(t => t.status === status);
    }

    return JSON.stringify({
      threads: threads.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        status: t.status,
        lifecycleLength: t.lifecycle.length,
        issueCount: t.issueIds.length,
      })),
      total: threads.length,
    });
  }

  private getPlotThreadDetails(input: Record<string, unknown>): string {
    const threadId = input.thread_id as string;
    const thread = this.analysis.plotThreads.find(t => t.id === threadId);

    if (!thread) {
      return JSON.stringify({ error: `Plot thread not found: ${threadId}` });
    }

    return JSON.stringify({
      id: thread.id,
      name: thread.name,
      description: thread.description,
      status: thread.status,
      lifecycle: thread.lifecycle.map(e => ({
        chunkId: e.chunkId,
        action: e.action,
        description: e.description,
        snippet: e.location.snippet.slice(0, 150),
      })),
      issueIds: thread.issueIds,
    });
  }

  private readChunk(input: Record<string, unknown>): string {
    const chunkId = input.chunk_id as string;
    const chunk = this.chunks.get(chunkId);

    if (!chunk) {
      return JSON.stringify({ error: `Chunk not found: ${chunkId}` });
    }

    return JSON.stringify({
      id: chunk.id,
      title: chunk.title,
      text: chunk.text,
      wordCount: chunk.text.split(/\s+/).length,
    });
  }

  private readTextAtLocation(input: Record<string, unknown>): string {
    const chunkId = input.chunk_id as string;
    const startOffset = input.start_offset as number;
    const endOffset = input.end_offset as number;
    const contextChars = (input.context_chars as number) || 200;

    const chunk = this.chunks.get(chunkId);
    if (!chunk) {
      return JSON.stringify({ error: `Chunk not found: ${chunkId}` });
    }

    const start = Math.max(0, startOffset - contextChars);
    const end = Math.min(chunk.text.length, endOffset + contextChars);

    return JSON.stringify({
      chunkId,
      chunkTitle: chunk.title,
      text: chunk.text.slice(start, end),
      actualStart: start,
      actualEnd: end,
      targetStart: startOffset,
      targetEnd: endOffset,
    });
  }

  private getExistingIssues(input: Record<string, unknown>): string {
    const type = input.type as string | undefined;
    const severity = input.severity as string | undefined;
    const characterId = input.character_id as string | undefined;

    let issues = this.analysis.issues;

    if (type) {
      issues = issues.filter(i => i.type === type);
    }
    if (severity) {
      issues = issues.filter(i => i.severity === severity);
    }
    if (characterId) {
      issues = issues.filter(i => i.relatedEntityIds.includes(characterId));
    }

    return JSON.stringify({
      issues: issues.map(i => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        title: i.title,
        description: i.description,
        chunkIds: i.chunkIds,
        relatedEntityIds: i.relatedEntityIds,
      })),
      total: issues.length,
    });
  }

  private getDocumentOverview(): string {
    const { summary, document } = this.analysis;

    return JSON.stringify({
      document: {
        title: document.title,
        wordCount: document.wordCount,
        chapterCount: document.chapterCount,
      },
      summary: {
        totalChunks: summary.totalChunks,
        characterCount: summary.characterCount,
        locationCount: summary.locationCount,
        objectCount: summary.objectCount,
        eventCount: summary.eventCount,
        plotThreadCount: summary.plotThreadCount,
        unresolvedThreadCount: summary.unresolvedThreadCount,
        issueCount: summary.issueCount,
        issuesBySeverity: summary.issuesBySeverity,
      },
      topCharacters: this.analysis.entities.characters
        .sort((a, b) => b.stats.totalMentions - a.stats.totalMentions)
        .slice(0, 10)
        .map(c => ({ id: c.id, name: c.name, mentions: c.stats.totalMentions })),
      plotThreads: this.analysis.plotThreads.map(t => ({
        id: t.id,
        name: t.name,
        status: t.status,
      })),
    });
  }

  private compareCharacterTimelines(input: Record<string, unknown>): string {
    const charId1 = input.character_id_1 as string;
    const charId2 = input.character_id_2 as string;

    const char1 = this.analysis.entities.characters.find(c => c.id === charId1);
    const char2 = this.analysis.entities.characters.find(c => c.id === charId2);

    if (!char1) return JSON.stringify({ error: `Character not found: ${charId1}` });
    if (!char2) return JSON.stringify({ error: `Character not found: ${charId2}` });

    // Find shared events
    const sharedEventIds = char1.eventIds.filter(id => char2.eventIds.includes(id));
    const sharedEvents = sharedEventIds
      .map(id => this.events.get(id))
      .filter(e => e)
      .map(e => ({
        id: e!.event.id,
        description: e!.event.description,
        timeMarker: e!.event.timeMarker,
        chunkId: e!.chunk.id,
      }));

    // Find events unique to each character
    const char1OnlyEvents = char1.eventIds
      .filter(id => !char2.eventIds.includes(id))
      .map(id => this.events.get(id))
      .filter(e => e)
      .slice(0, 10)
      .map(e => ({
        id: e!.event.id,
        description: e!.event.description,
        timeMarker: e!.event.timeMarker,
      }));

    const char2OnlyEvents = char2.eventIds
      .filter(id => !char1.eventIds.includes(id))
      .map(id => this.events.get(id))
      .filter(e => e)
      .slice(0, 10)
      .map(e => ({
        id: e!.event.id,
        description: e!.event.description,
        timeMarker: e!.event.timeMarker,
      }));

    // Find relationship between characters
    const relationship = char1.relationships.find(r => r.targetCharacterId === charId2);

    return JSON.stringify({
      character1: { id: char1.id, name: char1.name, eventCount: char1.eventIds.length },
      character2: { id: char2.id, name: char2.name, eventCount: char2.eventIds.length },
      relationship: relationship ? {
        type: relationship.relationship,
        sharedEventCount: relationship.sharedEventIds.length,
      } : null,
      sharedEvents,
      char1OnlyEvents,
      char2OnlyEvents,
    });
  }

  private reportInsight(input: Record<string, unknown>): string {
    const insight: CriticInsight = {
      type: input.type as CriticInsight['type'],
      severity: input.severity as CriticInsight['severity'],
      title: input.title as string,
      description: input.description as string,
      evidence: (input.evidence as CriticInsight['evidence']) || [],
      relatedEntityIds: (input.related_entity_ids as string[]) || [],
    };

    this.insights.push(insight);

    return JSON.stringify({
      success: true,
      message: `Insight recorded: ${insight.title}`,
      totalInsights: this.insights.length,
    });
  }
}

/**
 * Insight type - what the critic agent reports
 */
export interface CriticInsight {
  type:
    | 'continuity_issue'
    | 'character_arc_observation'
    | 'plot_hole'
    | 'pacing_concern'
    | 'thematic_insight'
    | 'structural_observation'
    | 'strength'
    | 'suggestion';
  severity: 'critical' | 'important' | 'minor' | 'observation';
  title: string;
  description: string;
  evidence: Array<{
    chunk_id?: string;
    quote?: string;
    note?: string;
  }>;
  relatedEntityIds: string[];
}
