#!/usr/bin/env node

/**
 * Book Editor CLI - Analyze manuscripts from the command line
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import {
  parseDocument,
  chunkDocument,
  analyzeDocument,
  validateManuscriptDir,
  loadManuscriptDir,
  createManifest,
  runCritic,
  insightsToIssues,
  AnalysisCache,
} from './src/index.js';
import type { Manifest, AnalysisOutput, CriticFocusArea } from './src/index.js';

const program = new Command();

program
  .name('book-editor')
  .description('Analyze manuscripts for continuity errors, plot holes, and more')
  .version('0.0.1');

// Main analyze command
program
  .command('analyze')
  .description('Analyze a manuscript for issues')
  .argument('<file>', 'Path to .docx, .txt, or .md file')
  .option('-o, --output <file>', 'Output JSON results to file')
  .option('-m, --model <model>', 'Claude model to use', 'claude-sonnet-4-20250514')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-c, --cache', 'Enable caching of extraction results (default: true)', true)
  .option('--no-cache', 'Disable caching')
  .option('--critic', 'Run literary critic agent after extraction')
  .option('--critic-focus <areas>', 'Focus areas for critic (comma-separated: continuity,character_development,plot_structure,pacing,themes)')
  .action(async (file, options) => {
    try {
      const filePath = resolve(file);
      console.log(`Analyzing: ${filePath}\n`);

      if (options.cache) {
        console.log('📁 Caching enabled (use --no-cache to disable)\n');
      }

      const result = await analyzeDocument(filePath, {
        model: options.model,
        cache: options.cache ? {} : undefined,
        onProgress: options.verbose
          ? (phase, completed, total) => {
              const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
              console.log(`  [${phase}] ${completed}/${total} (${pct}%)`);
            }
          : undefined,
      });

      // Run literary critic if requested
      let criticIssues: ReturnType<typeof insightsToIssues> = [];
      if (options.critic) {
        console.log('\n🔍 Running literary critic agent...\n');

        const focusAreas = options.criticFocus
          ? (options.criticFocus.split(',') as CriticFocusArea[])
          : undefined;

        const criticResult = await runCritic(result, {
          model: options.model,
          focusAreas,
          onProgress: (update) => {
            if (options.verbose) {
              console.log(`  [critic] Iteration ${update.iteration}/${update.maxIterations}: ${update.currentActivity || update.phase} (${update.insightsFound} insights)`);
            }
          },
        });

        console.log(`📝 Critic found ${criticResult.insights.length} additional insights`);
        console.log(`   (${criticResult.iterations} iterations, ${criticResult.tokenUsage.inputTokens + criticResult.tokenUsage.outputTokens} tokens)\n`);

        // Convert insights to issues format
        criticIssues = insightsToIssues(criticResult.insights, result.issues.length + 1);

        // Add critic issues to the output (stored separately for type safety)
        (result as AnalysisOutput & { criticIssues?: typeof criticIssues }).criticIssues = criticIssues;
      }

      // Print summary
      console.log('\n=== ANALYSIS COMPLETE ===\n');
      console.log(`Document: ${result.document.title}`);
      console.log(`Words: ${result.document.wordCount.toLocaleString()}`);
      console.log(`Chapters: ${result.document.chapterCount}`);
      console.log(`Chunks analyzed: ${result.summary.totalChunks}\n`);

      console.log('--- Entities ---');
      console.log(`Characters: ${result.summary.characterCount}`);
      console.log(`Locations: ${result.summary.locationCount}`);
      console.log(`Objects: ${result.summary.objectCount}\n`);

      console.log('--- Story Structure ---');
      console.log(`Timeline events: ${result.summary.eventCount}`);
      console.log(`Plot threads: ${result.summary.plotThreadCount} (${result.summary.unresolvedThreadCount} unresolved)`);
      console.log(`Setups: ${result.summary.setupCount} (${result.summary.unresolvedSetupCount} pending)\n`);

      console.log('--- Issues ---');
      console.log(`Total: ${result.summary.issueCount}`);
      console.log(`  Errors: ${result.summary.issuesBySeverity.error}`);
      console.log(`  Warnings: ${result.summary.issuesBySeverity.warning}`);
      console.log(`  Info: ${result.summary.issuesBySeverity.info}\n`);

      // List issues by severity
      if (result.issues.length > 0) {
        console.log('=== ISSUES ===\n');

        for (const severity of ['error', 'warning', 'info'] as const) {
          const issues = result.issues.filter((i) => i.severity === severity);
          if (issues.length === 0) continue;

          const icon = severity === 'error' ? '❌' : severity === 'warning' ? '⚠️' : 'ℹ️';
          console.log(`${icon} ${severity.toUpperCase()}S (${issues.length}):\n`);

          for (const issue of issues) {
            console.log(`  [${issue.type}] ${issue.title}`);
            console.log(`    ${issue.description}`);
            if (issue.evidence.length > 0) {
              const preview = issue.evidence[0].quote.length > 60
                ? issue.evidence[0].quote.slice(0, 60) + '...'
                : issue.evidence[0].quote;
              console.log(`    Evidence: "${preview}"`);
            }
            console.log();
          }
        }
      }

      // Output to file if requested
      if (options.output) {
        const outputPath = resolve(options.output);
        await writeFile(outputPath, JSON.stringify(result, null, 2));
        console.log(`\n✅ Full analysis saved to: ${outputPath}`);
        console.log(`   This file can be loaded directly by the frontend.`);
      } else {
        console.log('💡 Use --output <file.json> to save the full analysis for the frontend.');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Parse-only command (for debugging)
program
  .command('parse')
  .description('Parse a document and show structure (no API calls)')
  .argument('<file>', 'Path to .docx or .txt file')
  .action(async (file) => {
    try {
      const filePath = resolve(file);
      const doc = await parseDocument({ filePath });

      console.log(`Title: ${doc.title}`);
      console.log(`Paragraphs: ${doc.paragraphs.length}`);
      console.log(`Headings: ${doc.headings.length}\n`);

      if (doc.headings.length > 0) {
        console.log('Headings found:');
        for (const h of doc.headings) {
          console.log(`  ${'#'.repeat(h.level)} ${h.text} (para ${h.paragraphIndex})`);
        }
        console.log();
      }

      console.log('First 500 characters:');
      console.log(doc.fullText.slice(0, 500));
      console.log('...\n');
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Chunk command (for debugging)
program
  .command('chunk')
  .description('Chunk a document and show structure (no API calls)')
  .argument('<file>', 'Path to .docx or .txt file')
  .option('--strategy <strategy>', 'Chunking strategy: chapters, size, hybrid', 'hybrid')
  .option('--size <size>', 'Target chunk size', '8000')
  .action(async (file, options) => {
    try {
      const filePath = resolve(file);
      const doc = await parseDocument({ filePath });
      const chunks = chunkDocument(doc, {
        strategy: options.strategy,
        targetSize: parseInt(options.size, 10),
      });

      console.log(`Document: ${doc.title}`);
      console.log(`Total chunks: ${chunks.length}\n`);

      for (const chunk of chunks) {
        const preview = chunk.content.slice(0, 100).replace(/\n/g, ' ');
        console.log(`${chunk.id}: ${chunk.title || '(untitled)'}`);
        console.log(`  Length: ${chunk.content.length} chars`);
        console.log(`  Preview: ${preview}...`);
        console.log();
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Validate command
program
  .command('validate')
  .description('Validate a manuscript directory structure')
  .argument('<dir>', 'Path to manuscript directory')
  .action(async (dir) => {
    try {
      const dirPath = resolve(dir);
      console.log(`Validating: ${dirPath}\n`);

      const result = await validateManuscriptDir(dirPath);

      if (result.manifest) {
        console.log(`Title: ${result.manifest.title}`);
        console.log(`Type: ${result.manifest.type}`);
        console.log(`Manuscript: ${result.manifest.files.manuscript}`);
        console.log();
      }

      if (result.errors.length > 0) {
        console.log('ERRORS:');
        for (const err of result.errors) {
          console.log(`  ❌ ${err}`);
        }
        console.log();
      }

      if (result.warnings.length > 0) {
        console.log('WARNINGS:');
        for (const warn of result.warnings) {
          console.log(`  ⚠️  ${warn}`);
        }
        console.log();
      }

      if (result.valid) {
        console.log('✅ Manuscript directory is valid');

        if (result.expectedIssues) {
          console.log(`   Ground truth: ${result.expectedIssues.issues.length} expected issues`);
        }
      } else {
        console.log('❌ Validation failed');
        process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Literary critic command (for running on existing analysis)
program
  .command('critic')
  .description('Run the literary critic agent on an existing analysis')
  .argument('<analysis-json>', 'Path to analysis JSON file')
  .option('-o, --output <file>', 'Output updated JSON with critic insights')
  .option('-m, --model <model>', 'Claude model to use', 'claude-sonnet-4-20250514')
  .option('-v, --verbose', 'Show detailed progress')
  .option('--focus <areas>', 'Focus areas (comma-separated: continuity,character_development,plot_structure,pacing,themes)')
  .option('--max-iterations <n>', 'Maximum agent iterations', '25')
  .action(async (analysisFile, options) => {
    try {
      const filePath = resolve(analysisFile);
      console.log(`Loading analysis: ${filePath}\n`);

      const analysisJson = await readFile(filePath, 'utf-8');
      const analysis = JSON.parse(analysisJson) as AnalysisOutput;

      console.log(`Document: ${analysis.document.title}`);
      console.log(`Existing issues: ${analysis.issues.length}\n`);

      console.log('🔍 Running literary critic agent...\n');

      const focusAreas = options.focus
        ? (options.focus.split(',') as CriticFocusArea[])
        : undefined;

      const criticResult = await runCritic(analysis, {
        model: options.model,
        focusAreas,
        maxIterations: parseInt(options.maxIterations, 10),
        onProgress: (update) => {
          if (options.verbose) {
            console.log(`  [${update.phase}] Iteration ${update.iteration}/${update.maxIterations}: ${update.currentActivity || ''} (${update.insightsFound} insights)`);
          } else if (update.phase === 'investigating' && update.currentActivity) {
            process.stdout.write(`\r  Iteration ${update.iteration}: ${update.currentActivity}`.padEnd(60));
          }
        },
      });

      if (!options.verbose) {
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
      }

      console.log(`\n📝 Critic found ${criticResult.insights.length} insights:`);
      console.log(`   Tokens used: ${(criticResult.tokenUsage.inputTokens + criticResult.tokenUsage.outputTokens).toLocaleString()}`);
      console.log(`   Iterations: ${criticResult.iterations}\n`);

      // Show insights grouped by severity
      const insightsBySeverity = {
        critical: criticResult.insights.filter(i => i.severity === 'critical'),
        important: criticResult.insights.filter(i => i.severity === 'important'),
        minor: criticResult.insights.filter(i => i.severity === 'minor'),
        observation: criticResult.insights.filter(i => i.severity === 'observation'),
      };

      for (const [severity, insights] of Object.entries(insightsBySeverity)) {
        if (insights.length === 0) continue;

        const icons = { critical: '🔴', important: '🟡', minor: '🔵', observation: '⚪' };
        console.log(`${icons[severity as keyof typeof icons]} ${severity.toUpperCase()} (${insights.length}):\n`);

        for (const insight of insights) {
          console.log(`  [${insight.type}] ${insight.title}`);
          console.log(`    ${insight.description.slice(0, 200)}${insight.description.length > 200 ? '...' : ''}`);
          console.log();
        }
      }

      // Save updated analysis if output specified
      if (options.output) {
        const criticIssuesList = insightsToIssues(criticResult.insights, analysis.issues.length + 1);

        // Add critic issues to a separate field for type safety
        const outputData = {
          ...analysis,
          criticIssues: criticIssuesList,
        };

        const outputPath = resolve(options.output);
        await writeFile(outputPath, JSON.stringify(outputData, null, 2));
        console.log(`\n✅ Updated analysis saved to: ${outputPath}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Cache management command
program
  .command('cache')
  .description('Manage the analysis cache')
  .option('--stats', 'Show cache statistics')
  .option('--clear', 'Clear all cached data')
  .option('--dir <path>', 'Cache directory (default: .book-editor-cache)')
  .action(async (options) => {
    try {
      const cache = new AnalysisCache({
        cacheDir: options.dir,
      });

      if (options.clear) {
        cache.clear();
        console.log('✅ Cache cleared');
        return;
      }

      // Default to showing stats
      const stats = cache.getStats();
      console.log('📁 Cache Statistics:\n');
      console.log(`  Chunks cached: ${stats.chunks}`);
      console.log(`  Discovery results: ${stats.discovery}`);
      console.log(`  Extraction results: ${stats.extraction}`);
      console.log(`  Total size: ${stats.totalSize}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Gutenberg download command
program
  .command('gutenberg')
  .description('Download a book from Project Gutenberg')
  .argument('<id-or-url>', 'Book ID (e.g., 768) or full URL (e.g., https://www.gutenberg.org/ebooks/768)')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('--strip-header', 'Remove Project Gutenberg header/footer', true)
  .action(async (idOrUrl, options) => {
    try {
      // Extract book ID from URL or use directly
      let bookId: string;
      if (idOrUrl.includes('gutenberg.org')) {
        const match = idOrUrl.match(/ebooks\/(\d+)/);
        if (!match) {
          throw new Error('Could not parse book ID from URL');
        }
        bookId = match[1];
      } else {
        bookId = idOrUrl;
      }

      console.log(`Downloading book ID: ${bookId}`);

      // Fetch the plain text version
      const textUrl = `https://www.gutenberg.org/ebooks/${bookId}.txt.utf-8`;
      console.log(`Fetching: ${textUrl}`);

      const response = await fetch(textUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }

      let text = await response.text();

      // Extract metadata from the text
      const titleMatch = text.match(/Title:\s*(.+)/);
      const authorMatch = text.match(/Author:\s*(.+)/);
      const title = titleMatch ? titleMatch[1].trim() : `gutenberg-${bookId}`;
      const author = authorMatch ? authorMatch[1].trim() : undefined;
      const safeTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase();

      console.log(`Title: ${title}`);
      if (author) console.log(`Author: ${author}`);

      // Strip Gutenberg header/footer if requested
      if (options.stripHeader) {
        text = stripGutenbergBoilerplate(text);
        console.log('Stripped Project Gutenberg header/footer');
      }

      // Create directory structure
      const outputBase = resolve(options.output);
      const bookDir = join(outputBase, safeTitle);
      await mkdir(bookDir, { recursive: true });

      // Save manuscript
      const manuscriptFile = 'manuscript.txt';
      const manuscriptPath = join(bookDir, manuscriptFile);
      await writeFile(manuscriptPath, text);

      // Count words and chapters
      const wordCount = text.split(/\s+/).length;
      const chapterMatches = text.match(/^(Chapter|CHAPTER)\s+(\d+|[IVXLC]+)/gim);
      const chapterCount = chapterMatches ? chapterMatches.length : undefined;

      // Create manifest
      const manifest: Manifest = createManifest({
        title,
        type: 'gutenberg',
        manuscriptFile,
        source: {
          type: 'gutenberg',
          id: bookId,
          url: `https://www.gutenberg.org/ebooks/${bookId}`,
        },
        metadata: {
          author,
          wordCount,
          chapterCount,
        },
      });

      const manifestPath = join(bookDir, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      console.log(`\nCreated: ${bookDir}/`);
      console.log(`  ├── manifest.json`);
      console.log(`  └── ${manuscriptFile} (${(text.length / 1024).toFixed(1)} KB)`);
      console.log(`\nYou can now analyze it with:`);
      console.log(`  book-editor analyze ${join(bookDir, manuscriptFile)}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();

/**
 * Strip Project Gutenberg header and footer boilerplate
 */
function stripGutenbergBoilerplate(text: string): string {
  // Common start markers
  const startMarkers = [
    '*** START OF THE PROJECT GUTENBERG EBOOK',
    '*** START OF THIS PROJECT GUTENBERG EBOOK',
    '*END*THE SMALL PRINT',
    '***START OF THE PROJECT GUTENBERG EBOOK',
  ];

  // Common end markers
  const endMarkers = [
    '*** END OF THE PROJECT GUTENBERG EBOOK',
    '*** END OF THIS PROJECT GUTENBERG EBOOK',
    '***END OF THE PROJECT GUTENBERG EBOOK',
    'End of the Project Gutenberg EBook',
    'End of Project Gutenberg',
  ];

  let startIndex = 0;
  let endIndex = text.length;

  // Find start of actual content
  for (const marker of startMarkers) {
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      // Find the next line after the marker
      const lineEnd = text.indexOf('\n', idx);
      if (lineEnd !== -1) {
        startIndex = Math.max(startIndex, lineEnd + 1);
      }
    }
  }

  // Find end of actual content
  for (const marker of endMarkers) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && idx > startIndex) {
      endIndex = Math.min(endIndex, idx);
    }
  }

  return text.slice(startIndex, endIndex).trim();
}
