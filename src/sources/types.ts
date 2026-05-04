/**
 * Shared types and the FumadocsSource interface that both the remote (HTTP)
 * and local (filesystem) sources implement.
 */

export interface PageSummary {
  /** Stable identifier; for remote = page URL path, for local = relative file path. */
  id: string;
  /** Public URL path (e.g. "/docs/getting-started"). */
  url: string;
  title: string;
  description?: string;
  /** Heading-derived breadcrumbs / nav segments. */
  segments?: string[];
}

export interface PageContent extends PageSummary {
  /** Page body as Markdown. */
  markdown: string;
  /** Raw frontmatter / metadata. */
  meta: Record<string, unknown>;
  /** Table of contents (flat list of headings). */
  toc: TocEntry[];
}

export interface TocEntry {
  depth: number;
  title: string;
  anchor: string;
}

export interface SearchHit {
  url: string;
  title: string;
  description?: string;
  excerpt?: string;
  score?: number;
  tag?: string;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  tag?: string;
  locale?: string;
}

export interface FumadocsSource {
  readonly label: string;
  search(opts: SearchOptions): Promise<SearchHit[]>;
  listPages(prefix?: string): Promise<PageSummary[]>;
  getPage(ref: string): Promise<PageContent>;
  getToc(ref: string): Promise<TocEntry[]>;
  getMeta(ref: string): Promise<Record<string, unknown>>;
  getSection(ref: string, anchor: string): Promise<{ title: string; markdown: string }>;
  getLlmsTxt(full?: boolean): Promise<string | null>;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class SourceError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
