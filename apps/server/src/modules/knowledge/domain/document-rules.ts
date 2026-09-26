import { unprocessable, validationError } from '../../../shared-kernel/errors';

export type DocumentStatus =
  'uploaded' | 'extracting' | 'chunking' | 'embedding' | 'indexed' | 'failed';
export type DocumentKind = 'file' | 'note';
export type SupportedType = 'markdown' | 'text' | 'pdf';

/** Legal status transitions for the ingestion state machine. Re-ingesting restarts from uploaded. */
const TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  uploaded: ['extracting', 'failed'],
  extracting: ['chunking', 'failed', 'extracting'],
  chunking: ['embedding', 'failed', 'extracting'],
  embedding: ['indexed', 'failed', 'extracting'],
  indexed: ['uploaded', 'extracting'],
  failed: ['uploaded', 'extracting'],
};

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;

const EXTENSIONS: Record<string, SupportedType> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.pdf': 'pdf',
};

export const MIME_TYPES: Record<SupportedType, string> = {
  markdown: 'text/markdown',
  text: 'text/plain',
  pdf: 'application/pdf',
};

/**
 * Decides what an upload is from its bytes, not from what the client claims.
 * The extension must be supported AND the content must match it: PDFs must start with
 * the %PDF- signature; text files must be valid UTF-8 without NUL bytes.
 */
export function detectDocumentType(filename: string, bytes: Uint8Array): SupportedType {
  if (bytes.length === 0) throw validationError('EMPTY_FILE', 'The file is empty');
  if (bytes.length > MAX_UPLOAD_BYTES)
    throw validationError('FILE_TOO_LARGE', 'Files can be at most 10 MB');
  const lower = filename.toLowerCase();
  const extension = Object.keys(EXTENSIONS).find((ext) => lower.endsWith(ext));
  if (!extension) {
    throw unprocessable(
      'UNSUPPORTED_FILE_TYPE',
      'Upload Markdown (.md), text (.txt) or PDF (.pdf) files',
    );
  }
  const type = EXTENSIONS[extension]!;
  if (type === 'pdf') {
    const signature = String.fromCharCode(...bytes.slice(0, 5));
    if (signature !== '%PDF-')
      throw unprocessable('FILE_CONTENT_MISMATCH', 'This file is not a valid PDF');
    return type;
  }
  if (bytes.includes(0))
    throw unprocessable('FILE_CONTENT_MISMATCH', 'This file contains binary data, not text');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unprocessable('FILE_ENCODING_UNSUPPORTED', 'Text files must be UTF-8 encoded');
  }
  return type;
}

/** "Q3 Rollback-Runbook_v2.md" → "Q3 Rollback Runbook v2". Never used as a path. */
export function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const withoutExtension = base.replace(/\.[a-z0-9]+$/i, '');
  const spaced = withoutExtension.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "incident-response-runbook.md" → "Incident Response Runbook"; names that already use
  // capitals ("SLA v2", "iOS guide") are left as written.
  const titled =
    spaced === spaced.toLowerCase()
      ? spaced.replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
      : spaced;
  return (titled || 'Untitled document').slice(0, 200);
}

export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'upload';
  return base.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'upload';
}

/**
 * Heuristic prompt-injection markers. Detection is not prevention: a flagged document is
 * still indexed, but the UI warns and the flags are visible in the run inspector.
 * The real defence is that tools are least-privilege and writes need approval.
 */
const INJECTION_PATTERNS: [string, RegExp][] = [
  [
    'instruction_override',
    /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all)\b[^.\n]{0,20}\b(instructions|rules|prompts?)\b/i,
  ],
  [
    'role_hijack',
    /\byou are now\b|\bact as (the )?(system|developer|admin)\b|\bnew system prompt\b/i,
  ],
  [
    'prompt_extraction',
    /\b(reveal|print|show|repeat)\b[^.\n]{0,30}\b(system prompt|hidden instructions|your instructions)\b/i,
  ],
  [
    'exfiltration_link',
    /!\[[^\]]*\]\(https?:\/\/[^)]*\{|\b(send|post|upload|exfiltrate)\b[^.\n]{0,60}\bhttps?:\/\//i,
  ],
  [
    'tool_coercion',
    /\b(call|use|invoke)\b[^.\n]{0,20}\b(http_request|create_knowledge_note|tool)\b[^.\n]{0,40}\b(immediately|without (asking|approval))\b/i,
  ],
];

export function detectInjectionMarkers(text: string): string[] {
  return INJECTION_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([flag]) => flag);
}
