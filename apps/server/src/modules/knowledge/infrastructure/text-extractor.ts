import { extractText, getDocumentProxy } from 'unpdf';
import { unprocessable } from '../../../shared-kernel/errors';
import { MAX_PDF_PAGES, type SupportedType } from '../domain/document-rules';
import type { ExtractedText, TextExtractor } from '../application/ports';

/**
 * Markdown and text are decoded as UTF-8 and kept as-is (the chunker understands headings).
 * PDFs go through pdf.js (via unpdf, no native dependencies), one entry per page so chunks
 * can cite page numbers. Scanned PDFs have no text layer; OCR is on the roadmap.
 */
export class DefaultTextExtractor implements TextExtractor {
  async extract(type: SupportedType, bytes: Uint8Array): Promise<ExtractedText> {
    if (type === 'pdf') return this.extractPdf(bytes);
    const text = new TextDecoder('utf-8')
      .decode(bytes)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
    return { pages: [{ pageNumber: null, text }], pageCount: null };
  }

  private async extractPdf(bytes: Uint8Array): Promise<ExtractedText> {
    let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
    try {
      pdf = await getDocumentProxy(new Uint8Array(bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/password/i.test(message))
        throw unprocessable('PDF_ENCRYPTED', 'Password-protected PDFs are not supported');
      throw unprocessable('PDF_UNREADABLE', 'This PDF could not be read');
    }
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw unprocessable('PDF_TOO_LONG', `PDFs can have at most ${MAX_PDF_PAGES} pages`);
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((pageText, i) => ({
      pageNumber: i + 1,
      text: pageText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'),
    }));
    return { pages, pageCount: totalPages };
  }
}
