/**
 * Analyzer - Produces the AnalysisOutput format for the frontend
 *
 * Orchestrates:
 * 1. Discovery pass (identify all characters and plot threads)
 * 2. Extraction pass (per-chunk with entity context)
 * 3. Entity aggregation
 * 4. Timeline reconstruction
 * 5. Issue detection
 */

import type { ParsedDocument } from './types.js';
import type {
  AnalysisOutput,
  DocumentInfo,
  ChunkWithText,
  IssueWithContext,
  IssueType,
  EvidenceItem,
  AnalysisSummary,
  CharacterEntity,
  PlotThreadView,
  TokenUsage,
} from './output-schema.js';
import { discoverEntities } from './discovery.js';
import { extractFromChunks, type ExtractorOptions } from './extractor.js';
import { aggregateEntities } from './aggregator.js';
import { reconstructTimeline } from './timeline.js';
import { chunkDocument } from './chunker.js';
import { parseDocument } from './parser.js';
import { AnalysisCache, type CacheOptions } from './cache.js';

export interface AnalyzerOptions {
  apiKey?: string;
  model?: string;
  /** Enable caching of chunks and extraction results */
  cache?: boolean | CacheOptions;
  onProgress?: (phase: string, completed: number, total: number) => void;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Run full analysis and produce AnalysisOutput
 */
export async function analyzeDocument(
  input: string | Buffer,
  options: AnalyzerOptions = {}
): Promise<AnalysisOutput> {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  // Initialize cache if enabled
  const cache = options.cache
    ? new AnalysisCache(
        typeof options.cache === 'object' ? options.cache : {}
      )
    : undefined;

  if (cache) {
    const stats = cache.getStats();
    console.log(`[Cache] Using cache: ${stats.chunks} chunks, ${stats.discovery} discoveries, ${stats.extraction} extractions (${stats.totalSize})`);
  }

  // Phase 1: Parse document
  options.onProgress?.('parsing', 0, 1);
  let doc: ParsedDocument;
  if (typeof input === 'string' && !input.includes('\n')) {
    doc = await parseDocument({ filePath: input });
  } else if (typeof input === 'string') {
    doc = await parseDocument({ buffer: Buffer.from(input) });
  } else {
    doc = await parseDocument({ buffer: input });
  }
  options.onProgress?.('parsing', 1, 1);

  // Phase 2: Chunk document (check cache first)
  options.onProgress?.('chunking', 0, 1);
  let chunks = cache?.getChunks(doc.fullText) ?? null;
  if (!chunks) {
    chunks = chunkDocument(doc);
    cache?.setChunks(doc.fullText, chunks);
  }
  options.onProgress?.('chunking', 1, 1);

  // Phase 3: Discovery pass - identify all characters and plot threads
  const model = options.model || DEFAULT_MODEL;
  let discoveryResult = cache?.getDiscovery(doc.fullText, model) ?? null;

  if (!discoveryResult) {
    discoveryResult = await discoverEntities(chunks, {
      apiKey,
      model,
      onProgress: (completed, total) => {
        options.onProgress?.('discovering', completed, total);
      },
    });
    cache?.setDiscovery(doc.fullText, model, discoveryResult);
  } else {
    console.log('[Cache] Using cached discovery results');
    options.onProgress?.('discovering', 1, 1);
  }

  // Phase 4: Extraction pass - extract details with entity context
  const extractionResult = await extractFromChunks(chunks, {
    apiKey,
    model,
    discoveredEntities: discoveryResult.entities,
    cache,
    onProgress: (completed, total, chunkId) => {
      options.onProgress?.('extracting', completed, total);
    },
  });

  // Phase 5: Aggregate entities
  options.onProgress?.('aggregating', 0, 1);
  const aggregation = aggregateEntities(extractionResult.chunks);
  options.onProgress?.('aggregating', 1, 1);

  // Phase 6: Reconstruct timeline
  options.onProgress?.('timeline', 0, 1);
  const timeline = reconstructTimeline(aggregation.chunks);
  options.onProgress?.('timeline', 1, 1);

  // Phase 7: Detect issues
  options.onProgress?.('detecting', 0, 1);
  const issues = await detectIssues(
    aggregation.chunks,
    aggregation.entities.characters,
    aggregation.plotThreads,
    timeline,
    { apiKey, model: options.model || DEFAULT_MODEL }
  );
  options.onProgress?.('detecting', 1, 1);

  // Link issues to entities
  linkIssuesToEntities(issues, aggregation.entities.characters, aggregation.plotThreads);

  // Build token usage summary
  const tokenUsage = {
    discovery: discoveryResult.tokenUsage,
    extraction: extractionResult.tokenUsage,
    total: {
      inputTokens: discoveryResult.tokenUsage.inputTokens + extractionResult.tokenUsage.inputTokens,
      outputTokens: discoveryResult.tokenUsage.outputTokens + extractionResult.tokenUsage.outputTokens,
    },
  };

  // Build summary
  const summary = buildSummary(aggregation, timeline, issues, tokenUsage);

  // Build document info
  const documentInfo: DocumentInfo = {
    title: doc.title,
    wordCount: doc.fullText.split(/\s+/).length,
    charCount: doc.fullText.length,
    chapterCount: doc.headings.filter((h) => h.level <= 2).length,
  };

  return {
    schemaVersion: '1.0',
    analyzedAt: new Date().toISOString(),
    document: documentInfo,
    chunks: aggregation.chunks,
    entities: aggregation.entities,
    timeline,
    plotThreads: aggregation.plotThreads,
    issues,
    summary,
  };
}

/**
 * Detect issues using heuristics and AI
 */
async function detectIssues(
  chunks: ChunkWithText[],
  characters: CharacterEntity[],
  plotThreads: PlotThreadView[],
  timeline: ReturnType<typeof reconstructTimeline>,
  options: { apiKey: string; model: string }
): Promise<IssueWithContext[]> {
  const issues: IssueWithContext[] = [];
  let issueIdCounter = 0;

  // 1. Character inconsistencies (attribute conflicts)
  for (const char of characters) {
    const attributesByType = new Map<string, typeof char.attributes>();

    for (const attr of char.attributes) {
      const attrType = attr.attribute.toLowerCase();
      if (!attributesByType.has(attrType)) {
        attributesByType.set(attrType, []);
      }
      attributesByType.get(attrType)!.push(attr);
    }

    for (const [attrType, attrs] of attributesByType) {
      if (attrs.length >= 2) {
        // Check for conflicting values
        const uniqueValues = new Set(attrs.map((a) => a.value.toLowerCase()));
        if (uniqueValues.size > 1) {
          const issueId = `issue-${++issueIdCounter}`;

          issues.push({
            id: issueId,
            type: 'character_inconsistency',
            severity: 'error',
            title: `${char.name}'s ${attrType} inconsistency`,
            description: `${char.name} is described with conflicting ${attrType}: ${Array.from(uniqueValues).join(' vs ')}`,
            chunkIds: attrs.map((a) => a.location.chunkId),
            evidence: attrs.map((a) => ({
              quote: a.location.snippet,
              location: a.location,
              note: `${attrType}: ${a.value}`,
            })),
            relatedEntityIds: [char.id],
            status: 'open',
          });

          // Mark attributes as conflicting
          for (let i = 1; i < attrs.length; i++) {
            attrs[i].conflictsWith = { attributeIndex: 0, issueId };
          }

          char.issueIds.push(issueId);
        }
      }
    }
  }

  // 2. Unresolved plot threads
  for (const thread of plotThreads) {
    if (thread.status === 'abandoned') {
      const issueId = `issue-${++issueIdCounter}`;

      issues.push({
        id: issueId,
        type: 'unresolved_thread',
        severity: 'warning',
        title: `Unresolved: ${thread.name}`,
        description: `Plot thread "${thread.name}" was introduced but never resolved or advanced`,
        chunkIds: thread.lifecycle.map((e) => e.chunkId),
        evidence: thread.lifecycle.map((e) => ({
          quote: e.location.snippet,
          location: e.location,
          note: e.action,
        })),
        relatedEntityIds: [],
        status: 'open',
      });

      thread.issueIds.push(issueId);
    }
  }

  // 3. Dropped characters (appear once early, never again)
  for (const char of characters) {
    if (
      char.stats.totalMentions === 1 &&
      char.appearances.length === 1 &&
      char.appearances[0].role === 'present'
    ) {
      // Check if first half of story
      const chunkIndex = chunks.findIndex((c) => c.id === char.appearances[0].chunkId);
      if (chunkIndex >= 0 && chunkIndex < chunks.length / 2) {
        const issueId = `issue-${++issueIdCounter}`;

        issues.push({
          id: issueId,
          type: 'dropped_character',
          severity: 'info',
          title: `Dropped character: ${char.name}`,
          description: `${char.name} appears in ${char.appearances[0].chunkId} and is never seen again`,
          chunkIds: [char.appearances[0].chunkId],
          evidence:
            char.appearances[0].mentions.length > 0
              ? [
                  {
                    quote: char.appearances[0].mentions[0].snippet,
                    location: char.appearances[0].mentions[0],
                    note: 'Only appearance',
                  },
                ]
              : [],
          relatedEntityIds: [char.id],
          status: 'open',
        });

        char.issueIds.push(issueId);
      }
    }
  }

  // 4. Timeline inconsistencies (from timeline module)
  for (const inconsistency of timeline.inconsistencies) {
    const issueId = `issue-${++issueIdCounter}`;
    inconsistency.issueId = issueId;

    // Find the events to get their locations
    const events: EvidenceItem[] = [];
    for (const chunk of chunks) {
      for (const event of chunk.extraction.events) {
        if (inconsistency.eventIds.includes(event.id)) {
          events.push({
            quote: event.location.snippet,
            location: event.location,
            note: event.timeMarker,
          });
        }
      }
    }

    issues.push({
      id: issueId,
      type: 'timeline_inconsistency',
      severity: 'error',
      title: 'Timeline conflict',
      description: inconsistency.description,
      chunkIds: events.map((e) => e.location.chunkId),
      evidence: events,
      relatedEntityIds: [],
      status: 'open',
    });
  }

  // 5. Orphaned setups (foreshadowing without payoff)
  for (const chunk of chunks) {
    for (const setup of chunk.extraction.setups) {
      if (setup.status === 'pending' && setup.weight !== 'subtle') {
        // Check if this setup might be orphaned
        // For now, mark moderate/heavy setups without payoff as potential issues
        const issueId = `issue-${++issueIdCounter}`;
        setup.issueId = issueId;

        issues.push({
          id: issueId,
          type: 'orphaned_payoff',
          severity: setup.weight === 'heavy' ? 'warning' : 'info',
          title: `Unresolved setup: ${setup.description}`,
          description: `Setup "${setup.description}" implies payoff "${setup.impliedPayoff}" but no resolution was detected`,
          chunkIds: [chunk.id],
          evidence: [
            {
              quote: setup.location.snippet,
              location: setup.location,
              note: `${setup.weight} foreshadowing`,
            },
          ],
          relatedEntityIds: [],
          status: 'open',
        });
      }
    }
  }

  return issues;
}

/**
 * Link issues back to entities
 */
function linkIssuesToEntities(
  issues: IssueWithContext[],
  characters: CharacterEntity[],
  plotThreads: PlotThreadView[]
): void {
  // Already done during issue detection, but this could do additional linking
}

/**
 * Build summary statistics
 */
function buildSummary(
  aggregation: ReturnType<typeof aggregateEntities>,
  timeline: ReturnType<typeof reconstructTimeline>,
  issues: IssueWithContext[],
  tokenUsage: TokenUsage
): AnalysisSummary {
  const issuesByType: Record<IssueType, number> = {
    timeline_inconsistency: 0,
    character_inconsistency: 0,
    fact_contradiction: 0,
    unresolved_thread: 0,
    orphaned_payoff: 0,
    missing_setup: 0,
    over_foreshadowed: 0,
    under_foreshadowed: 0,
    dropped_character: 0,
    dropped_object: 0,
    continuity_error: 0,
  };

  const issuesBySeverity = { error: 0, warning: 0, info: 0 };

  for (const issue of issues) {
    issuesByType[issue.type]++;
    issuesBySeverity[issue.severity]++;
  }

  const eventCount = aggregation.chunks.reduce(
    (sum, chunk) => sum + chunk.extraction.events.length,
    0
  );

  const setupCount = aggregation.chunks.reduce(
    (sum, chunk) => sum + chunk.extraction.setups.length,
    0
  );

  const unresolvedSetupCount = aggregation.chunks.reduce(
    (sum, chunk) =>
      sum + chunk.extraction.setups.filter((s) => s.status === 'pending').length,
    0
  );

  return {
    totalChunks: aggregation.chunks.length,
    characterCount: aggregation.entities.characters.length,
    locationCount: aggregation.entities.locations.length,
    objectCount: aggregation.entities.objects.length,
    eventCount,
    plotThreadCount: aggregation.plotThreads.length,
    unresolvedThreadCount: aggregation.plotThreads.filter(
      (t) => t.status === 'abandoned'
    ).length,
    setupCount,
    unresolvedSetupCount,
    issueCount: issues.length,
    issuesByType,
    issuesBySeverity,
    tokenUsage,
  };
}
