export interface PrerenderRoute {
  route: string;
  contents?: string;
  data?: ArrayBuffer;
  fileName?: string;
  error?: Error & { statusCode: number; statusMessage: string };
  /**
   * Pages that linked to this route (only set on failed routes).
   *
   * In `prerender:route` it lists only the pages crawled so far; the complete list is available in `prerender:done`.
   */
  linkedFrom?: string[];
  generateTimeMS?: number;
  skip?: boolean;
  contentType?: string;
}

/** @deprecated Internal type will be removed in future versions */
export type PrerenderGenerateRoute = PrerenderRoute;
