#!/usr/bin/env node

/**
 * Book Editor CLI - Analyze manuscripts from the command line
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { resolve, join, basename } from 'path';
import {
  parseDocument,
  parseText,
  chunkDocument,
  extractFromChunks,
  analyzeExtractions,
  analyzeDocument,
  analyzeDocumentV2,
  validateManuscriptDir,
  loadManuscriptDir,
  createManifest,
  compareIssues,
} from './src/index.js';
import type { Manifest, AnalysisOutput } from './src/index.js';

const program = new Command();

program
  .name('book-editor')
  .description('Analyze manuscripts for continuity errors, plot holes, and more')
  .version('0.0.1');

// Main analyze command
program
  .command('analyze')
  .description('Analyze a manuscript for issues')
  .argument('<file>', 'Path to .docx or .txt file')
  .option('-o, --output <file>', 'Output JSON results to file')
  .option('-m, --model <model>', 'Claude model to use', 'claude-sonnet-4-20250514')
  .option('--chunk-size <size>', 'Target chunk size in characters', '8000')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (file, options) => {
    try {
      const filePath = resolve(file);
      console.log(`Analyzing: ${filePath}\n`);

      const result = await analyzeDocument(filePath, {
        chunk: {
          targetSize: parseInt(options.chunkSize, 10),
        },
        extract: {
          model: options.model,
          onProgress: options.verbose
            ? (done, total, chunkId) => {
                console.log(`  Extracting ${chunkId} (${done}/${total})`);
              }
            : undefined,
        },
      });

      // Print summary
      console.log('=== ANALYSIS COMPLETE ===\n');
      console.log(`Chunks analyzed: ${result.summary.totalChunks}`);
      console.log(`Characters found: ${result.summary.totalCharacters}`);
      console.log(`Plot threads: ${result.summary.totalPlotThreads}`);
      console.log(`Timeline events: ${result.summary.timelineEvents}`);
      console.log(`Issues found: ${result.summary.issueCount}\n`);

      // Print issues
      if (result.issues.length > 0) {
        console.log('=== ISSUES ===\n');

        const grouped = groupBy(result.issues, (i) => i.severity);

        for (const severity of ['error', 'warning', 'info'] as const) {
          const issues = grouped[severity] || [];
          if (issues.length === 0) continue;

          const icon = severity === 'error' ? '❌' : severity === 'warning' ? '⚠️' : 'ℹ️';
          console.log(`${icon} ${severity.toUpperCase()}S (${issues.length}):\n`);

          for (const issue of issues) {
            console.log(`  [${issue.type}] ${issue.title}`);
            console.log(`    ${issue.description}`);
            if (issue.evidence.length > 0) {
              console.log(`    Evidence: ${issue.evidence.join('; ')}`);
            }
            console.log(`    Chunks: ${issue.chunkIds.join(', ')}\n`);
          }
        }
      } else {
        console.log('No issues found! 🎉\n');
      }

      // Output to file if requested
      if (options.output) {
        const outputPath = resolve(options.output);
        await writeFile(outputPath, JSON.stringify(result, null, 2));
        console.log(`Results saved to: ${outputPath}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// V2 Analyze command (enhanced output format for frontend)
program
  .command('analyze-v2')
  .description('Analyze with enhanced output format (for frontend development)')
  .argument('<file>', 'Path to .docx or .txt file')
  .option('-o, --output <file>', 'Output JSON results to file (required for full output)')
  .option('-m, --model <model>', 'Claude model to use', 'claude-sonnet-4-20250514')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (file, options) => {
    try {
      const filePath = resolve(file);
      console.log(`Analyzing (v2): ${filePath}\n`);

      const result = await analyzeDocumentV2(filePath, {
        model: options.model,
        onProgress: options.verbose
          ? (phase, completed, total) => {
              const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
              console.log(`  [${phase}] ${completed}/${total} (${pct}%)`);
            }
          : undefined,
      });

      // Print summary
      console.log('\n=== ANALYSIS COMPLETE (V2) ===\n');
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
              console.log(`    Evidence: "${issue.evidence[0].quote.slice(0, 60)}..."`);
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

// Extract command (extraction only, no cross-chunk analysis)
program
  .command('extract')
  .description('Extract structured data from a document')
  .argument('<file>', 'Path to .docx or .txt file')
  .option('-o, --output <file>', 'Output JSON results to file')
  .option('-m, --model <model>', 'Claude model to use', 'claude-sonnet-4-20250514')
  .action(async (file, options) => {
    try {
      const filePath = resolve(file);
      console.log(`Extracting from: ${filePath}\n`);

      const doc = await parseDocument({ filePath });
      const chunks = chunkDocument(doc);

      console.log(`Chunks: ${chunks.length}`);

      const extractions = await extractFromChunks(chunks, {
        model: options.model,
        onProgress: (done, total, chunkId) => {
          console.log(`  Extracted ${chunkId} (${done}/${total})`);
        },
      });

      console.log('\n=== EXTRACTIONS ===\n');

      for (const ext of extractions) {
        console.log(`--- ${ext.chunkId} ---`);
        console.log(`  Timeline events: ${ext.timelineEvents.length}`);
        console.log(`  Characters: ${ext.characters.map((c) => c.name).join(', ') || '(none)'}`);
        console.log(`  Facts: ${ext.factsEstablished.length}`);
        console.log(`  Plot threads: ${ext.plotThreads.length}`);
        console.log(`  Setups: ${ext.setups.length}`);
        console.log(`  Questions: ${ext.openQuestions.length}`);
        console.log();
      }

      if (options.output) {
        const outputPath = resolve(options.output);
        await writeFile(outputPath, JSON.stringify(extractions, null, 2));
        console.log(`Results saved to: ${outputPath}`);
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

// Analyze directory command (validates first)
program
  .command('analyze-dir')
  .description('Analyze a manuscript directory (validates structure first)')
  .argument('<dir>', 'Path to manuscript directory')
  .option('-o, --output <file>', 'Output JSON results to file')
  .option('-m, --model <model>', 'Claude model to use', 'claude-sonnet-4-20250514')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (dir, options) => {
    try {
      const dirPath = resolve(dir);
      console.log(`Loading manuscript directory: ${dirPath}\n`);

      // Validate and load
      const { manifest, manuscriptPath, expectedIssues } = await loadManuscriptDir(dirPath);

      console.log(`Title: ${manifest.title}`);
      console.log(`Type: ${manifest.type}`);
      console.log(`Analyzing: ${manifest.files.manuscript}\n`);

      // Run analysis
      const result = await analyzeDocument(manuscriptPath, {
        extract: {
          model: options.model,
          onProgress: options.verbose
            ? (done, total, chunkId) => {
                console.log(`  Extracting ${chunkId} (${done}/${total})`);
              }
            : undefined,
        },
      });

      // Print summary
      console.log('=== ANALYSIS COMPLETE ===\n');
      console.log(`Chunks analyzed: ${result.summary.totalChunks}`);
      console.log(`Characters found: ${result.summary.totalCharacters}`);
      console.log(`Plot threads: ${result.summary.totalPlotThreads}`);
      console.log(`Issues found: ${result.summary.issueCount}\n`);

      // Print issues
      if (result.issues.length > 0) {
        console.log('=== ISSUES ===\n');
        const grouped = groupBy(result.issues, (i) => i.severity);

        for (const severity of ['error', 'warning', 'info'] as const) {
          const issues = grouped[severity] || [];
          if (issues.length === 0) continue;

          const icon = severity === 'error' ? '❌' : severity === 'warning' ? '⚠️' : 'ℹ️';
          console.log(`${icon} ${severity.toUpperCase()}S (${issues.length}):\n`);

          for (const issue of issues) {
            console.log(`  [${issue.type}] ${issue.title}`);
            console.log(`    ${issue.description}`);
            console.log();
          }
        }
      }

      // Compare against ground truth for synthetic manuscripts
      if (manifest.type === 'synthetic' && expectedIssues) {
        console.log('=== GROUND TRUTH COMPARISON ===\n');

        const comparison = compareIssues(result.issues, expectedIssues.issues);

        console.log(`Expected issues: ${expectedIssues.issues.length}`);
        console.log(`Detected issues: ${result.issues.length}`);
        console.log(`Matched: ${comparison.matched.length}`);
        console.log(`Missed: ${comparison.missed.length}`);
        console.log(`Extra: ${comparison.extra.length}\n`);

        if (comparison.missed.length > 0) {
          console.log('MISSED (expected but not detected):');
          for (const issue of comparison.missed) {
            console.log(`  - [${issue.type}] ${issue.title}`);
          }
          console.log();
        }

        if (comparison.extra.length > 0) {
          console.log('EXTRA (detected but not expected):');
          for (const issue of comparison.extra) {
            console.log(`  - [${issue.type}] ${issue.title}`);
          }
          console.log();
        }

        const accuracy = comparison.matched.length / expectedIssues.issues.length;
        console.log(`Detection rate: ${(accuracy * 100).toFixed(1)}%`);
      }

      if (options.output) {
        const outputPath = resolve(options.output);
        await writeFile(outputPath, JSON.stringify(result, null, 2));
        console.log(`\nResults saved to: ${outputPath}`);
      }
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
      console.log(`  book-editor analyze-dir ${bookDir}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();

// Utilities
function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  return arr.reduce(
    (acc, item) => {
      const key = fn(item);
      acc[key] = acc[key] || [];
      acc[key].push(item);
      return acc;
    },
    {} as Record<string, T[]>
  );
}

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
