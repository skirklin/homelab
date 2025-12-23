/**
 * Document parser - converts .docx files to structured text
 */
import mammoth from 'mammoth';
import { readFile } from 'fs/promises';
/**
 * Parse a document file into structured text
 * Supports .docx and .txt files
 */
export async function parseDocument(options) {
    // Handle plain text files
    if (options.filePath && (options.filePath.endsWith('.txt') || options.filePath.endsWith('.md'))) {
        const text = await readFile(options.filePath, 'utf-8');
        const filename = options.filePath.split('/').pop()?.replace(/\.(txt|md)$/, '');
        return parseText(text, filename);
    }
    // Handle .docx files
    let buffer;
    if (options.buffer) {
        buffer = options.buffer;
    }
    else if (options.filePath) {
        buffer = await readFile(options.filePath);
    }
    else {
        throw new Error('Either filePath or buffer must be provided');
    }
    // Extract HTML (preserves structure better than plain text)
    const htmlResult = await mammoth.convertToHtml({ buffer: buffer });
    const textResult = await mammoth.extractRawText({ buffer: buffer });
    // Parse the HTML to extract headings and structure
    const { headings, paragraphs } = parseHtml(htmlResult.value);
    // Try to extract title from first heading or first paragraph
    const title = headings.length > 0
        ? headings[0].text
        : paragraphs[0]?.slice(0, 100) || 'Untitled';
    return {
        title,
        fullText: textResult.value,
        paragraphs,
        headings,
    };
}
/**
 * Simple HTML parser to extract structure
 * (Avoids heavy DOM dependencies for Node.js compatibility)
 */
function parseHtml(html) {
    const headings = [];
    const paragraphs = [];
    // Split by paragraph and heading tags
    const blockPattern = /<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    let paragraphIndex = 0;
    while ((match = blockPattern.exec(html)) !== null) {
        const tag = match[1].toLowerCase();
        const content = stripHtml(match[2]).trim();
        if (!content)
            continue;
        if (tag.startsWith('h')) {
            const level = parseInt(tag[1], 10);
            headings.push({
                level,
                text: content,
                paragraphIndex,
            });
        }
        paragraphs.push(content);
        paragraphIndex++;
    }
    // If no block elements found, split by newlines
    if (paragraphs.length === 0) {
        const plainText = stripHtml(html);
        const lines = plainText.split(/\n+/).filter(line => line.trim());
        paragraphs.push(...lines);
    }
    return { headings, paragraphs };
}
/**
 * Strip HTML tags from a string
 */
function stripHtml(html) {
    return html
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}
/**
 * Parse plain text (for .txt files or pasted content)
 */
export function parseText(text, title) {
    const lines = text.split(/\n/).filter(line => line.trim());
    const paragraphs = [];
    const headings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        // Detect markdown-style headings
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            headings.push({
                level: headingMatch[1].length,
                text: headingMatch[2],
                paragraphIndex: paragraphs.length,
            });
        }
        // Detect chapter markers (common patterns)
        const chapterMatch = line.match(/^(Chapter|CHAPTER|Part|PART)\s+(\d+|[IVXLC]+)/i);
        if (chapterMatch) {
            headings.push({
                level: 1,
                text: line,
                paragraphIndex: paragraphs.length,
            });
        }
        paragraphs.push(line);
    }
    return {
        title: title || headings[0]?.text || 'Untitled',
        fullText: text,
        paragraphs,
        headings,
    };
}
//# sourceMappingURL=parser.js.map