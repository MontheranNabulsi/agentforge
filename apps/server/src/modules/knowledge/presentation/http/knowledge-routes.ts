import {
  ChunkDto,
  DocumentDto,
  DocumentListQuery,
  Id,
  KnowledgeSearchInput,
  KnowledgeSearchResponse,
  pageOf,
  UploadDocumentResponse,
} from '@agentforge/contracts';
import { z } from 'zod';
import { requireActor } from '../../../../platform/http/auth-context';
import type { App } from '../../../../platform/http/server';
import { validationError } from '../../../../shared-kernel/errors';
import { toDocumentDto, type KnowledgeUseCases } from '../../application/knowledge-use-cases';

const ProjectParams = z.object({ projectId: Id });
const DocumentParams = z.object({ documentId: Id });

export function knowledgeRoutes(deps: {
  knowledge: KnowledgeUseCases;
  embeddingModel: () => string;
}) {
  const { knowledge } = deps;
  const named = (request: Parameters<typeof requireActor>[0]) => ({
    ...requireActor(request),
    name: request.auth!.user.name,
  });

  return async (api: App) => {
    api.post(
      '/projects/:projectId/documents',
      {
        schema: {
          tags: ['knowledge'],
          summary: 'Upload a document (multipart field "file"; Markdown, TXT or PDF up to 10 MB)',
          consumes: ['multipart/form-data'],
          params: ProjectParams,
          response: { 200: UploadDocumentResponse, 201: UploadDocumentResponse },
        },
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      },
      async (request, reply) => {
        const actor = named(request);
        if (!request.isMultipart())
          throw validationError('MULTIPART_REQUIRED', 'Send the file as multipart/form-data');
        const file = await request.file();
        if (!file) throw validationError('FILE_REQUIRED', 'Attach a file in the "file" field');
        const bytes = new Uint8Array(await file.toBuffer());
        const result = await knowledge.upload(actor, request.params.projectId, {
          filename: file.filename,
          bytes,
        });
        return reply
          .status(result.duplicate ? 200 : 201)
          .send({ document: toDocumentDto(result.document), duplicate: result.duplicate });
      },
    );

    api.get(
      '/projects/:projectId/documents',
      {
        schema: {
          tags: ['knowledge'],
          params: ProjectParams,
          querystring: DocumentListQuery,
          response: { 200: pageOf(DocumentDto) },
        },
      },
      async (request) => {
        const q = request.query;
        const page = await knowledge.list(requireActor(request), request.params.projectId, {
          limit: q.limit,
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.status ? { status: q.status } : {}),
        });
        return { data: page.data.map(toDocumentDto), page: page.page };
      },
    );

    api.get(
      '/documents/:documentId',
      { schema: { tags: ['knowledge'], params: DocumentParams, response: { 200: DocumentDto } } },
      async (request) =>
        toDocumentDto(await knowledge.get(requireActor(request), request.params.documentId)),
    );

    api.get(
      '/documents/:documentId/chunks',
      {
        schema: {
          tags: ['knowledge'],
          summary: 'The chunks a document was split into (what retrieval actually searches)',
          params: DocumentParams,
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(200).default(50),
            offset: z.coerce.number().int().min(0).default(0),
          }),
          response: { 200: z.array(ChunkDto) },
        },
      },
      async (request) => {
        const chunks = await knowledge.chunks(
          requireActor(request),
          request.params.documentId,
          request.query,
        );
        return chunks.map((c) => ({
          id: c.id,
          index: c.index,
          content: c.content,
          headingPath: c.headingPath,
          pageNumber: c.pageNumber,
          tokenCount: c.tokenCount,
        }));
      },
    );

    api.delete(
      '/documents/:documentId',
      { schema: { tags: ['knowledge'], params: DocumentParams } },
      async (request, reply) => {
        await knowledge.remove(named(request), request.params.documentId);
        return reply.status(204).send();
      },
    );

    api.post(
      '/documents/:documentId/reindex',
      { schema: { tags: ['knowledge'], params: DocumentParams, response: { 200: DocumentDto } } },
      async (request) =>
        toDocumentDto(await knowledge.reindex(named(request), request.params.documentId)),
    );

    api.post(
      '/projects/:projectId/knowledge/search',
      {
        schema: {
          tags: ['knowledge'],
          summary: 'Hybrid retrieval playground: see what an agent would retrieve for a query',
          params: ProjectParams,
          body: KnowledgeSearchInput,
          response: { 200: KnowledgeSearchResponse },
        },
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      },
      async (request) => {
        const started = Date.now();
        const results = await knowledge.search(
          requireActor(request),
          request.params.projectId,
          request.body,
        );
        return { results, embeddingModel: deps.embeddingModel(), tookMs: Date.now() - started };
      },
    );
  };
}
