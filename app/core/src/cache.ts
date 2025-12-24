/**
 * Cache - Persistent caching for analysis results
 *
 * Caches:
 * - Document chunks (based on content hash)
 * - Discovery results (per document)
 * - Per-chunk extraction results (per chunk content hash)
 *
 * Cache is stored on the filesystem to persist across runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Chunk } from './types.js';
import type { ChunkWithText } from './output-schema.js';
import type { DiscoveryResult, DiscoveredEntities, DiscoveredCharacter, DiscoveredThread } from './discovery.js';

export interface CacheOptions {
  /** Directory to store cache files. Defaults to .book-editor-cache in cwd */
  cacheDir?: string;
  /** Whether to use caching. Defaults to true */
  enabled?: boolean;
}

interface CacheMetadata {
  createdAt: string;
  model: string;
  version: string;
}

interface ChunksCache {
  metadata: CacheMetadata;
  documentHash: string;
  chunks: Chunk[];
}

interface DiscoveryCache {
  metadata: CacheMetadata;
  documentHash: string;
  entities: DiscoveredEntities;
  tokenUsage: { inputTokens: number; outputTokens: number };
}

interface ExtractionCache {
  metadata: CacheMetadata;
  chunkHash: string;
  extraction: ChunkWithText['extraction'];
  tokenUsage: { inputTokens: number; outputTokens: number };
}

// Cache version - bump this when schema changes
const CACHE_VERSION = '1.0.0';

export class AnalysisCache {
  private cacheDir: string;
  private enabled: boolean;

  constructor(options: CacheOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.cacheDir = options.cacheDir ?? path.join(process.cwd(), '.book-editor-cache');

    if (this.enabled) {
      this.ensureCacheDir();
    }
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    // Create subdirectories
    for (const subdir of ['chunks', 'discovery', 'extraction']) {
      const subdirPath = path.join(this.cacheDir, subdir);
      if (!fs.existsSync(subdirPath)) {
        fs.mkdirSync(subdirPath, { recursive: true });
      }
    }
  }

  /**
   * Generate a hash for content
   */
  static hash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Get cached chunks for a document
   */
  getChunks(documentContent: string): Chunk[] | null {
    if (!this.enabled) return null;

    const docHash = AnalysisCache.hash(documentContent);
    const cachePath = path.join(this.cacheDir, 'chunks', `${docHash}.json`);

    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as ChunksCache;
        if (cached.metadata.version === CACHE_VERSION) {
          console.log(`[Cache] Using cached chunks for document ${docHash}`);
          return cached.chunks;
        }
      }
    } catch (e) {
      console.warn('[Cache] Error reading chunks cache:', e);
    }

    return null;
  }

  /**
   * Save chunks to cache
   */
  setChunks(documentContent: string, chunks: Chunk[]): void {
    if (!this.enabled) return;

    const docHash = AnalysisCache.hash(documentContent);
    const cachePath = path.join(this.cacheDir, 'chunks', `${docHash}.json`);

    const cacheData: ChunksCache = {
      metadata: {
        createdAt: new Date().toISOString(),
        model: 'n/a',
        version: CACHE_VERSION,
      },
      documentHash: docHash,
      chunks,
    };

    try {
      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
      console.log(`[Cache] Saved chunks for document ${docHash}`);
    } catch (e) {
      console.warn('[Cache] Error writing chunks cache:', e);
    }
  }

  /**
   * Get cached discovery results for a document
   */
  getDiscovery(documentContent: string, model: string): DiscoveryResult | null {
    if (!this.enabled) return null;

    const docHash = AnalysisCache.hash(documentContent);
    const modelHash = AnalysisCache.hash(model);
    const cachePath = path.join(this.cacheDir, 'discovery', `${docHash}-${modelHash}.json`);

    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DiscoveryCache;
        if (cached.metadata.version === CACHE_VERSION && cached.metadata.model === model) {
          console.log(`[Cache] Using cached discovery for document ${docHash}`);
          return {
            entities: cached.entities,
            tokenUsage: cached.tokenUsage,
          };
        }
      }
    } catch (e) {
      console.warn('[Cache] Error reading discovery cache:', e);
    }

    return null;
  }

  /**
   * Save discovery results to cache
   */
  setDiscovery(documentContent: string, model: string, result: DiscoveryResult): void {
    if (!this.enabled) return;

    const docHash = AnalysisCache.hash(documentContent);
    const modelHash = AnalysisCache.hash(model);
    const cachePath = path.join(this.cacheDir, 'discovery', `${docHash}-${modelHash}.json`);

    const cacheData: DiscoveryCache = {
      metadata: {
        createdAt: new Date().toISOString(),
        model,
        version: CACHE_VERSION,
      },
      documentHash: docHash,
      entities: result.entities,
      tokenUsage: result.tokenUsage,
    };

    try {
      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
      console.log(`[Cache] Saved discovery for document ${docHash}`);
    } catch (e) {
      console.warn('[Cache] Error writing discovery cache:', e);
    }
  }

  /**
   * Get cached extraction for a single chunk
   */
  getExtraction(
    chunkContent: string,
    chunkId: string,
    model: string,
    discoveredEntitiesHash: string
  ): { extraction: ChunkWithText['extraction']; tokenUsage: { inputTokens: number; outputTokens: number } } | null {
    if (!this.enabled) return null;

    const chunkHash = AnalysisCache.hash(chunkContent);
    const modelHash = AnalysisCache.hash(model);
    const contextHash = AnalysisCache.hash(discoveredEntitiesHash);
    const cachePath = path.join(this.cacheDir, 'extraction', `${chunkHash}-${modelHash}-${contextHash}.json`);

    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as ExtractionCache;
        if (cached.metadata.version === CACHE_VERSION && cached.metadata.model === model) {
          console.log(`[Cache] Using cached extraction for chunk ${chunkId}`);
          return {
            extraction: cached.extraction,
            tokenUsage: cached.tokenUsage,
          };
        }
      }
    } catch (e) {
      console.warn('[Cache] Error reading extraction cache:', e);
    }

    return null;
  }

  /**
   * Save extraction results for a single chunk
   */
  setExtraction(
    chunkContent: string,
    model: string,
    discoveredEntitiesHash: string,
    extraction: ChunkWithText['extraction'],
    tokenUsage: { inputTokens: number; outputTokens: number }
  ): void {
    if (!this.enabled) return;

    const chunkHash = AnalysisCache.hash(chunkContent);
    const modelHash = AnalysisCache.hash(model);
    const contextHash = AnalysisCache.hash(discoveredEntitiesHash);
    const cachePath = path.join(this.cacheDir, 'extraction', `${chunkHash}-${modelHash}-${contextHash}.json`);

    const cacheData: ExtractionCache = {
      metadata: {
        createdAt: new Date().toISOString(),
        model,
        version: CACHE_VERSION,
      },
      chunkHash,
      extraction,
      tokenUsage,
    };

    try {
      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    } catch (e) {
      console.warn('[Cache] Error writing extraction cache:', e);
    }
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    if (!this.enabled) return;

    try {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      this.ensureCacheDir();
      console.log('[Cache] Cache cleared');
    } catch (e) {
      console.warn('[Cache] Error clearing cache:', e);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { chunks: number; discovery: number; extraction: number; totalSize: string } {
    if (!this.enabled) {
      return { chunks: 0, discovery: 0, extraction: 0, totalSize: '0 B' };
    }

    const countFiles = (dir: string): number => {
      try {
        return fs.readdirSync(path.join(this.cacheDir, dir)).filter(f => f.endsWith('.json')).length;
      } catch {
        return 0;
      }
    };

    const getDirSize = (dir: string): number => {
      try {
        const files = fs.readdirSync(path.join(this.cacheDir, dir));
        return files.reduce((sum, file) => {
          const stat = fs.statSync(path.join(this.cacheDir, dir, file));
          return sum + stat.size;
        }, 0);
      } catch {
        return 0;
      }
    };

    const totalBytes = getDirSize('chunks') + getDirSize('discovery') + getDirSize('extraction');
    const totalSize = totalBytes < 1024
      ? `${totalBytes} B`
      : totalBytes < 1024 * 1024
        ? `${(totalBytes / 1024).toFixed(1)} KB`
        : `${(totalBytes / 1024 / 1024).toFixed(1)} MB`;

    return {
      chunks: countFiles('chunks'),
      discovery: countFiles('discovery'),
      extraction: countFiles('extraction'),
      totalSize,
    };
  }
}

/**
 * Create a hash of discovered entities for cache key purposes
 */
export function hashDiscoveredEntities(entities: DiscoveredEntities): string {
  // Create a stable string representation
  const stable = JSON.stringify({
    characters: entities.characters.map((c: DiscoveredCharacter) => c.name).sort(),
    plotThreads: entities.plotThreads.map((t: DiscoveredThread) => t.name).sort(),
  });
  return AnalysisCache.hash(stable);
}
