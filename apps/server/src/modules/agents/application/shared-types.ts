/** Shapes shared by the tool layer and the ports (kept apart to avoid an import cycle). */

export interface SourceChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string;
  pageNumber: number | null;
  content: string;
  score?: number;
}

/** A retrieved passage with the [n] index the model cites it by. */
export interface SourceRef {
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string;
  pageNumber: number | null;
  content: string;
}

export interface ProjectQueryInput {
  entity: 'agent_runs' | 'documents' | 'conversations' | 'tool_calls' | 'approvals';
  aggregate: 'count' | 'list';
  status?: string | undefined;
  since?: '24h' | '7d' | '30d' | 'all' | undefined;
  groupBy?: 'status' | 'day' | 'tool' | 'agent' | undefined;
  limit?: number | undefined;
}
