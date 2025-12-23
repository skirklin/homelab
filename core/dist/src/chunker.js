/**
 * Document chunker - splits documents into analyzable pieces
 */
const DEFAULT_OPTIONS = {
    strategy: 'hybrid',
    targetSize: 8000, // ~2000 tokens, good for detailed analysis
    maxSize: 16000, // ~4000 tokens max
    minSize: 1000, // ~250 tokens min
};
/**
 * Split a parsed document into chunks for analysis
 */
export function chunkDocument(doc, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    switch (opts.strategy) {
        case 'chapters':
            return chunkByChapters(doc, opts);
        case 'size':
            return chunkBySize(doc, opts);
        case 'hybrid':
        default:
            return chunkHybrid(doc, opts);
    }
}
/**
 * Chunk by detected chapter/section headings
 */
function chunkByChapters(doc, opts) {
    const chunks = [];
    if (doc.headings.length === 0) {
        // No headings found, fall back to size-based chunking
        return chunkBySize(doc, opts);
    }
    // Find top-level headings (lowest level number = highest importance)
    const minLevel = Math.min(...doc.headings.map(h => h.level));
    const chapterHeadings = doc.headings.filter(h => h.level <= minLevel + 1);
    for (let i = 0; i < chapterHeadings.length; i++) {
        const heading = chapterHeadings[i];
        const nextHeading = chapterHeadings[i + 1];
        const startIndex = heading.paragraphIndex;
        const endIndex = nextHeading
            ? nextHeading.paragraphIndex
            : doc.paragraphs.length;
        const content = doc.paragraphs.slice(startIndex, endIndex).join('\n\n');
        chunks.push({
            id: `chunk-${i + 1}`,
            title: heading.text,
            content,
            startIndex,
            endIndex,
        });
    }
    // Handle any content before the first heading
    if (chapterHeadings[0]?.paragraphIndex > 0) {
        const preambleContent = doc.paragraphs
            .slice(0, chapterHeadings[0].paragraphIndex)
            .join('\n\n');
        if (preambleContent.trim().length > opts.minSize) {
            chunks.unshift({
                id: 'chunk-0',
                title: 'Preamble',
                content: preambleContent,
                startIndex: 0,
                endIndex: chapterHeadings[0].paragraphIndex,
            });
        }
    }
    return chunks;
}
/**
 * Chunk by target size, breaking at paragraph boundaries
 */
function chunkBySize(doc, opts) {
    const chunks = [];
    let currentChunk = [];
    let currentSize = 0;
    let startIndex = 0;
    let chunkNum = 1;
    for (let i = 0; i < doc.paragraphs.length; i++) {
        const para = doc.paragraphs[i];
        const paraSize = para.length;
        // If adding this paragraph would exceed max, start a new chunk
        if (currentSize + paraSize > opts.maxSize && currentChunk.length > 0) {
            chunks.push({
                id: `chunk-${chunkNum}`,
                title: null,
                content: currentChunk.join('\n\n'),
                startIndex,
                endIndex: i,
            });
            chunkNum++;
            currentChunk = [];
            currentSize = 0;
            startIndex = i;
        }
        currentChunk.push(para);
        currentSize += paraSize;
        // If we've reached target size, consider ending the chunk
        if (currentSize >= opts.targetSize) {
            // Look ahead for a good break point (paragraph that looks like section end)
            const isGoodBreak = isParagraphBreak(para) ||
                (i + 1 < doc.paragraphs.length && isParagraphBreak(doc.paragraphs[i + 1]));
            if (isGoodBreak || currentSize >= opts.maxSize) {
                chunks.push({
                    id: `chunk-${chunkNum}`,
                    title: null,
                    content: currentChunk.join('\n\n'),
                    startIndex,
                    endIndex: i + 1,
                });
                chunkNum++;
                currentChunk = [];
                currentSize = 0;
                startIndex = i + 1;
            }
        }
    }
    // Don't forget the last chunk
    if (currentChunk.length > 0) {
        chunks.push({
            id: `chunk-${chunkNum}`,
            title: null,
            content: currentChunk.join('\n\n'),
            startIndex,
            endIndex: doc.paragraphs.length,
        });
    }
    return chunks;
}
/**
 * Hybrid: use chapters when available, subdivide large chapters by size
 */
function chunkHybrid(doc, opts) {
    const chapterChunks = chunkByChapters(doc, opts);
    const result = [];
    for (const chunk of chapterChunks) {
        if (chunk.content.length <= opts.maxSize) {
            result.push(chunk);
        }
        else {
            // Subdivide large chapters
            const subDoc = {
                title: chunk.title || 'Untitled',
                fullText: chunk.content,
                paragraphs: chunk.content.split('\n\n').filter(p => p.trim()),
                headings: [],
            };
            const subChunks = chunkBySize(subDoc, opts);
            for (let i = 0; i < subChunks.length; i++) {
                result.push({
                    ...subChunks[i],
                    id: `${chunk.id}-${i + 1}`,
                    title: chunk.title ? `${chunk.title} (Part ${i + 1})` : null,
                    // Adjust indices to be relative to original document
                    startIndex: chunk.startIndex + subChunks[i].startIndex,
                    endIndex: chunk.startIndex + subChunks[i].endIndex,
                });
            }
        }
    }
    return result;
}
/**
 * Heuristic: does this paragraph look like a section break?
 */
function isParagraphBreak(para) {
    const trimmed = para.trim();
    // Scene break markers
    if (/^[*#-]{3,}$/.test(trimmed))
        return true;
    if (trimmed === '***' || trimmed === '---' || trimmed === '###')
        return true;
    // Very short paragraph (often indicates break)
    if (trimmed.length < 20)
        return true;
    // Ends with strong punctuation
    if (/[.!?]["']?$/.test(trimmed))
        return true;
    return false;
}
/**
 * Utility: estimate token count (rough approximation)
 */
export function estimateTokens(text) {
    // Rough estimate: ~4 characters per token for English prose
    return Math.ceil(text.length / 4);
}
//# sourceMappingURL=chunker.js.map