/**
 * Manifest schema and validation for test manuscript directories
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
/**
 * Validate a manuscript directory against the expected schema
 */
export async function validateManuscriptDir(dirPath) {
    const errors = [];
    const warnings = [];
    // Check manifest.json exists
    const manifestPath = join(dirPath, 'manifest.json');
    let manifest;
    try {
        await access(manifestPath);
    }
    catch {
        errors.push(`Missing required file: manifest.json`);
        return { valid: false, errors, warnings };
    }
    // Parse manifest.json
    try {
        const content = await readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(content);
    }
    catch (e) {
        errors.push(`Invalid JSON in manifest.json: ${e instanceof Error ? e.message : e}`);
        return { valid: false, errors, warnings };
    }
    // Validate required fields
    if (!manifest.title || typeof manifest.title !== 'string') {
        errors.push('manifest.json: missing or invalid "title" field');
    }
    if (!manifest.type || !['synthetic', 'gutenberg', 'user'].includes(manifest.type)) {
        errors.push('manifest.json: missing or invalid "type" field (must be synthetic|gutenberg|user)');
    }
    if (!manifest.files || typeof manifest.files !== 'object') {
        errors.push('manifest.json: missing "files" object');
    }
    else if (!manifest.files.manuscript || typeof manifest.files.manuscript !== 'string') {
        errors.push('manifest.json: missing or invalid "files.manuscript" field');
    }
    // If we have errors in required fields, stop here
    if (errors.length > 0) {
        return { valid: false, errors, warnings, manifest };
    }
    // Check that referenced files exist
    const manuscriptPath = join(dirPath, manifest.files.manuscript);
    try {
        await access(manuscriptPath);
    }
    catch {
        errors.push(`Manuscript file not found: ${manifest.files.manuscript}`);
    }
    // Check alternative formats if specified
    if (manifest.files.manuscriptFormats) {
        for (const format of manifest.files.manuscriptFormats) {
            const formatPath = join(dirPath, format);
            try {
                await access(formatPath);
            }
            catch {
                warnings.push(`Alternative format not found: ${format}`);
            }
        }
    }
    // For synthetic manuscripts, check expectedIssues
    let expectedIssues;
    if (manifest.type === 'synthetic') {
        if (!manifest.files.expectedIssues) {
            warnings.push('Synthetic manuscript missing "files.expectedIssues" - no ground truth for validation');
        }
        else {
            const issuesPath = join(dirPath, manifest.files.expectedIssues);
            try {
                await access(issuesPath);
                const content = await readFile(issuesPath, 'utf-8');
                expectedIssues = JSON.parse(content);
                // Validate expected issues structure
                if (!expectedIssues.issues || !Array.isArray(expectedIssues.issues)) {
                    errors.push('expected-issues.json: missing or invalid "issues" array');
                }
                else {
                    for (let i = 0; i < expectedIssues.issues.length; i++) {
                        const issue = expectedIssues.issues[i];
                        if (!issue.type) {
                            errors.push(`expected-issues.json: issue[${i}] missing "type"`);
                        }
                        if (!issue.title) {
                            errors.push(`expected-issues.json: issue[${i}] missing "title"`);
                        }
                    }
                }
            }
            catch (e) {
                if (e.code === 'ENOENT') {
                    errors.push(`Expected issues file not found: ${manifest.files.expectedIssues}`);
                }
                else {
                    errors.push(`Invalid JSON in expected-issues.json: ${e instanceof Error ? e.message : e}`);
                }
            }
        }
    }
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        manifest,
        expectedIssues,
    };
}
/**
 * Load a manuscript directory, validating it first
 */
export async function loadManuscriptDir(dirPath) {
    const validation = await validateManuscriptDir(dirPath);
    if (!validation.valid) {
        throw new Error(`Invalid manuscript directory:\n  ${validation.errors.join('\n  ')}`);
    }
    if (validation.warnings.length > 0) {
        console.warn(`Warnings:\n  ${validation.warnings.join('\n  ')}`);
    }
    return {
        manifest: validation.manifest,
        manuscriptPath: join(dirPath, validation.manifest.files.manuscript),
        expectedIssues: validation.expectedIssues,
    };
}
/**
 * Create a manifest for a new manuscript directory
 */
export function createManifest(options) {
    return {
        title: options.title,
        type: options.type,
        source: options.source,
        files: {
            manuscript: options.manuscriptFile,
            expectedIssues: options.expectedIssuesFile,
        },
        metadata: options.metadata,
    };
}
/**
 * Compare detected issues against expected issues (for synthetic tests)
 */
export function compareIssues(detected, expected) {
    const matched = [];
    const missed = [];
    const usedDetected = new Set();
    // Try to match each expected issue to a detected one
    for (const exp of expected) {
        let foundMatch = false;
        for (let i = 0; i < detected.length; i++) {
            if (usedDetected.has(i))
                continue;
            const det = detected[i];
            // Match on type and similar title
            if (det.type === exp.type && titlesSimilar(det.title, exp.title)) {
                matched.push({ detected: det, expected: exp });
                usedDetected.add(i);
                foundMatch = true;
                break;
            }
        }
        if (!foundMatch) {
            missed.push(exp);
        }
    }
    // Any unmatched detected issues are "extra"
    const extra = detected.filter((_, i) => !usedDetected.has(i));
    return { matched, missed, extra };
}
/**
 * Check if two issue titles are similar enough to be considered a match
 */
function titlesSimilar(a, b) {
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const na = normalize(a);
    const nb = normalize(b);
    // Exact match after normalization
    if (na === nb)
        return true;
    // One contains the other
    if (na.includes(nb) || nb.includes(na))
        return true;
    // Check for common key words
    const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
    return overlap >= 2 || overlap >= Math.min(wordsA.size, wordsB.size) * 0.5;
}
//# sourceMappingURL=manifest.js.map