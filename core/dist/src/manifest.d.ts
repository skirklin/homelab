/**
 * Manifest schema and validation for test manuscript directories
 */
import type { Issue } from './types.js';
/** Source information for downloaded books */
export interface ManifestSource {
    type: 'original' | 'gutenberg' | 'upload';
    id?: string;
    url?: string;
}
/** File references in the manifest */
export interface ManifestFiles {
    /** Primary manuscript file (required) */
    manuscript: string;
    /** Alternative formats of the same manuscript */
    manuscriptFormats?: string[];
    /** Ground truth issues for validation (synthetic only) */
    expectedIssues?: string;
}
/** Optional metadata about the book */
export interface ManifestMetadata {
    author?: string;
    year?: number;
    wordCount?: number;
    chapterCount?: number;
}
/** The manifest.json schema */
export interface Manifest {
    /** Human-readable title */
    title: string;
    /** Type of test manuscript */
    type: 'synthetic' | 'gutenberg' | 'user';
    /** Origin info for downloaded books */
    source?: ManifestSource;
    /** File references */
    files: ManifestFiles;
    /** Optional metadata */
    metadata?: ManifestMetadata;
}
/** Expected issue format for ground truth */
export interface ExpectedIssue {
    type: string;
    severity: 'error' | 'warning' | 'info';
    title: string;
    description: string;
    locations?: Array<{
        chapter?: number | string;
        quote?: string;
    }>;
}
export interface ExpectedIssuesFile {
    issues: ExpectedIssue[];
}
/** Validation result */
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    manifest?: Manifest;
    expectedIssues?: ExpectedIssuesFile;
}
/**
 * Validate a manuscript directory against the expected schema
 */
export declare function validateManuscriptDir(dirPath: string): Promise<ValidationResult>;
/**
 * Load a manuscript directory, validating it first
 */
export declare function loadManuscriptDir(dirPath: string): Promise<{
    manifest: Manifest;
    manuscriptPath: string;
    expectedIssues?: ExpectedIssuesFile;
}>;
/**
 * Create a manifest for a new manuscript directory
 */
export declare function createManifest(options: {
    title: string;
    type: Manifest['type'];
    manuscriptFile: string;
    source?: ManifestSource;
    metadata?: ManifestMetadata;
    expectedIssuesFile?: string;
}): Manifest;
/**
 * Compare detected issues against expected issues (for synthetic tests)
 */
export declare function compareIssues(detected: Issue[], expected: ExpectedIssue[]): {
    matched: Array<{
        detected: Issue;
        expected: ExpectedIssue;
    }>;
    missed: ExpectedIssue[];
    extra: Issue[];
};
//# sourceMappingURL=manifest.d.ts.map