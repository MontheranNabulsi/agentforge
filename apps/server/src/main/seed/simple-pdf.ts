/**
 * Writes a small, valid text PDF (PDF 1.4, Helvetica, one page per ~45 lines). Used only to
 * seed a PDF document so the PDF ingestion path is exercised in the demo without binary
 * fixtures in the repository.
 */
export function simplePdf(lines: string[], options: { title?: string } = {}): Uint8Array {
  const escape = (text: string) =>
    text
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[^\x20-\x7e]/g, '?');
  const perPage = 45;
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage)
    pages.push(lines.slice(i, i + perPage));

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const content = [
      'BT',
      '/F1 11 Tf',
      '14 TL',
      '56 780 Td',
      ...pageLines.map((line, index) => `${index === 0 ? '' : 'T* '}(${escape(line)}) Tj`),
      'ET',
    ].join('\n');
    const contentId = add(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const infoId = add(
    `<< /Title (${escape(options.title ?? 'Document')}) /Producer (AgentForge seed) >>`,
  );

  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
