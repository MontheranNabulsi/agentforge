import { estimateTokens } from '../../../shared-kernel/text';

export interface ChunkerOptions {
  /** Aim for chunks around this size (tokens, estimated). */
  targetTokens: number;
  /** Never exceed this; oversized paragraphs are split by sentence. */
  maxTokens: number;
  /** Tail of the previous chunk repeated at the start of the next one (same section only). */
  overlapTokens: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  targetTokens: 350,
  maxTokens: 550,
  overlapTokens: 50,
};

export interface TextPage {
  pageNumber: number | null;
  text: string;
}

export interface Chunk {
  index: number;
  content: string;
  headingPath: string;
  pageNumber: number | null;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

interface Block {
  text: string;
  headingPath: string;
  pageNumber: number | null;
  start: number;
  end: number;
}

/**
 * Heading-aware chunking.
 *
 * 1. Walk the text line by line, tracking the Markdown heading stack ("Runbook > Rollback").
 * 2. Split sections into paragraphs; split paragraphs that exceed maxTokens into sentences.
 * 3. Pack consecutive blocks of the same section into chunks near targetTokens.
 * 4. Repeat the last ~overlapTokens of a chunk at the start of the next chunk in the same section,
 *    so an answer spanning a boundary still lands in one chunk.
 *
 * Chunks never cross a heading: a chunk about "Rollback" never contains half of "Monitoring".
 * Pure function, deterministic, unit-tested; sizes are tuned by evaluations, not intuition.
 */
export function chunkDocument(
  pages: TextPage[],
  options: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS,
): Chunk[] {
  const blocks = toBlocks(pages, options);
  const chunks: Chunk[] = [];
  let current: Block[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    const content = current
      .map((b) => b.text)
      .join('\n\n')
      .trim();
    if (content) {
      chunks.push({
        index: chunks.length,
        content,
        headingPath: current[0]!.headingPath,
        pageNumber: current[0]!.pageNumber,
        charStart: current[0]!.start,
        charEnd: current.at(-1)!.end,
        tokenCount: estimateTokens(content),
      });
    }
  };

  for (const block of blocks) {
    const tokens = estimateTokens(block.text);
    const sameSection = current.length > 0 && current[0]!.headingPath === block.headingPath;
    if (current.length > 0 && (!sameSection || currentTokens + tokens > options.targetTokens)) {
      const previous = current;
      flush();
      current = [];
      currentTokens = 0;
      if (sameSection && options.overlapTokens > 0) {
        const overlap = tailOf(previous, options.overlapTokens);
        if (overlap) {
          current.push(overlap);
          currentTokens = estimateTokens(overlap.text);
        }
      }
    }
    current.push(block);
    currentTokens += tokens;
  }
  flush();
  return chunks;
}

function toBlocks(pages: TextPage[], options: ChunkerOptions): Block[] {
  const blocks: Block[] = [];
  const headings: string[] = [];
  let offset = 0;

  for (const page of pages) {
    const text = page.text.replace(/\r\n?/g, '\n');
    let paragraph: string[] = [];
    let paragraphStart = offset;
    let cursor = offset;

    const pushParagraph = (end: number) => {
      const joined = paragraph.join('\n').trim();
      paragraph = [];
      if (!joined) return;
      const headingPath = headings.filter(Boolean).join(' > ');
      for (const piece of splitOversized(joined, options.maxTokens)) {
        blocks.push({
          text: piece,
          headingPath,
          pageNumber: page.pageNumber,
          start: paragraphStart,
          end,
        });
      }
    };

    for (const line of text.split('\n')) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        pushParagraph(cursor);
        const level = heading[1]!.length;
        headings.length = level - 1;
        headings[level - 1] = heading[2]!.trim();
        paragraphStart = cursor + line.length + 1;
      } else if (line.trim() === '') {
        pushParagraph(cursor);
        paragraphStart = cursor + 1;
      } else {
        if (paragraph.length === 0) paragraphStart = cursor;
        paragraph.push(line);
      }
      cursor += line.length + 1;
    }
    pushParagraph(cursor);
    offset = cursor;
  }
  return blocks;
}

function splitOversized(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && estimateTokens(`${current} ${sentence}`) > maxTokens) {
      pieces.push(current);
      current = '';
    }
    if (estimateTokens(sentence) > maxTokens) {
      // A single enormous "sentence" (tables, minified text): hard-wrap by characters.
      const width = maxTokens * 4;
      for (let i = 0; i < sentence.length; i += width) pieces.push(sentence.slice(i, i + width));
      continue;
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}

function tailOf(blocks: Block[], overlapTokens: number): Block | null {
  const last = blocks.at(-1);
  if (!last) return null;
  const sentences = last.text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  let tokens = 0;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i]!;
    const cost = estimateTokens(sentence);
    if (tokens + cost > overlapTokens && kept.length > 0) break;
    kept.unshift(sentence);
    tokens += cost;
    if (tokens >= overlapTokens) break;
  }
  const text = kept.join(' ').trim();
  if (!text || text === last.text) return null;
  return { ...last, text };
}
