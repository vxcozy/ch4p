/**
 * WebSearch tool — search the web using the Brave Search API.
 *
 * Heavyweight tool that queries the Brave Search API and returns formatted
 * search results. Requires a Brave Search API key configured via
 * `search.apiKey` in ch4p config (supports ${BRAVE_SEARCH_API_KEY} env var).
 *
 * Disabled by default (security-first). Enable in config:
 *   { "search": { "enabled": true, "provider": "brave", "apiKey": "${BRAVE_SEARCH_API_KEY}" } }
 *
 * Security: The tool only contacts the Brave Search API endpoint
 * (api.search.brave.com). No user-controlled URLs are constructed.
 */

import type {
  ITool,
  ToolContext,
  ToolResult,
  ValidationResult,
  JSONSchema7,
} from '@ch4p/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebSearchArgs {
  query: string;
  count?: number;
  offset?: number;
  freshness?: string;
  country?: string;
}

/** Extended ToolContext with search configuration injected via toolContextExtensions. */
export interface SearchToolContext extends ToolContext {
  searchApiKey?: string;
  searchConfig?: {
    maxResults?: number;
    country?: string;
    searchLang?: string;
  };
}

/** Shape of a single Brave Search web result. */
interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  extra_snippets?: string[];
}

/** Shape of the Brave Search API response (relevant fields). */
interface BraveSearchResponse {
  web?: {
    results: BraveWebResult[];
  };
  query?: {
    original: string;
    altered?: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_LENGTH = 50_000;
const VALID_FRESHNESS = new Set(['pd', 'pw', 'pm', 'py']);

// ---------------------------------------------------------------------------
// WebSearchTool
// ---------------------------------------------------------------------------

export class WebSearchTool implements ITool {
  readonly name = 'web_search';
  readonly description =
    'Search the web for current information. Returns titles, URLs, and ' +
    'descriptions from web search results. Use this to find facts, research ' +
    'topics, or look up current events.';

  readonly weight = 'heavyweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Be specific for better results.',
        minLength: 1,
      },
      count: {
        type: 'integer',
        description: 'Number of results to return (1-20). Default: 5.',
        minimum: 1,
        maximum: 20,
      },
      offset: {
        type: 'integer',
        description: 'Pagination offset. Use to get additional pages of results.',
        minimum: 0,
      },
      freshness: {
        type: 'string',
        description:
          'Time filter for results. pd=past day, pw=past week, pm=past month, py=past year.',
        enum: ['pd', 'pw', 'pm', 'py'],
      },
      country: {
        type: 'string',
        description: 'Country code for localized results (e.g., US, GB, DE).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  };

  private abortController: AbortController | null = null;

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const { query, count, offset, freshness, country } = args as Record<string, unknown>;
    const errors: string[] = [];

    // query: required non-empty string
    if (typeof query !== 'string' || query.trim().length === 0) {
      errors.push('query must be a non-empty string.');
    } else if (query.length > 2000) {
      errors.push('query must be 2000 characters or fewer.');
    }

    // count: optional integer 1-20
    if (count !== undefined) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 20) {
        errors.push('count must be an integer between 1 and 20.');
      }
    }

    // offset: optional non-negative integer
    if (offset !== undefined) {
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        errors.push('offset must be a non-negative integer.');
      }
    }

    // freshness: optional enum
    if (freshness !== undefined) {
      if (typeof freshness !== 'string' || !VALID_FRESHNESS.has(freshness)) {
        errors.push('freshness must be one of: pd, pw, pm, py.');
      }
    }

    // country: optional string
    if (country !== undefined) {
      if (typeof country !== 'string' || country.trim().length === 0) {
        errors.push('country must be a non-empty string.');
      }
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validation = this.validate(args);
    if (!validation.valid) {
      return {
        success: false,
        output: '',
        error: `Invalid arguments: ${validation.errors!.join(' ')}`,
      };
    }

    const { query, count, offset, freshness, country } = args as WebSearchArgs;
    const searchContext = context as SearchToolContext;

    // Check for API key — try context extension first, then env var as fallback.
    const apiKey = searchContext.searchApiKey || process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        output: '',
        error:
          'Web search is not available: no Brave Search API key found. ' +
          'The BRAVE_SEARCH_API_KEY environment variable is not set, and ' +
          'search.apiKey is not configured in ~/.ch4p/config.json. ' +
          'Please tell the user to set the BRAVE_SEARCH_API_KEY environment variable ' +
          'in the shell where the ch4p gateway is running.',
      };
    }

    // Check if already aborted.
    if (context.abortSignal.aborted) {
      return {
        success: false,
        output: '',
        error: 'Request aborted before execution.',
      };
    }

    // Chain abort controllers.
    this.abortController = new AbortController();
    const onContextAbort = () => this.abortController?.abort();
    context.abortSignal.addEventListener('abort', onContextAbort, { once: true });

    // Set up timeout.
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, DEFAULT_TIMEOUT_MS);

    try {
      context.onProgress(`Searching for "${query}"...`);

      // Build the Brave Search API URL.
      const searchConfig = searchContext.searchConfig ?? {};
      const effectiveCount = count ?? searchConfig.maxResults ?? 5;

      const url = new URL(BRAVE_API_URL);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(effectiveCount));
      if (offset) url.searchParams.set('offset', String(offset));
      if (freshness) url.searchParams.set('freshness', freshness);

      const effectiveCountry = country ?? searchConfig.country;
      if (effectiveCountry) url.searchParams.set('country', effectiveCountry);

      if (searchConfig.searchLang) {
        url.searchParams.set('search_lang', searchConfig.searchLang);
      }

      const response = await fetch(url.toString(), {
        signal: this.abortController.signal,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });

      // Handle HTTP errors with specific messages.
      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) {
          return {
            success: false,
            output: '',
            error: 'Invalid or expired Brave Search API key.',
            metadata: { query, status },
          };
        }
        if (status === 429) {
          return {
            success: false,
            output: '',
            error: 'Brave Search rate limit exceeded. Try again later.',
            metadata: { query, status },
          };
        }
        return {
          success: false,
          output: '',
          error: `Search API returned HTTP ${status}: ${response.statusText}`,
          metadata: { query, status },
        };
      }

      const data = (await response.json()) as BraveSearchResponse;
      const results = data.web?.results ?? [];

      // Format results for LLM consumption.
      let output = formatSearchResults(results, data.query);

      // Truncate if necessary.
      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n\n... [results truncated] ...';
      }

      return {
        success: true,
        output,
        metadata: {
          query,
          provider: 'brave',
          resultCount: results.length,
          offset: offset ?? 0,
        },
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (context.abortSignal.aborted) {
          return {
            success: false,
            output: '',
            error: 'Request was aborted.',
          };
        }
        return {
          success: false,
          output: '',
          error: `Search request timed out after ${DEFAULT_TIMEOUT_MS}ms.`,
          metadata: { query, timedOut: true },
        };
      }

      return {
        success: false,
        output: '',
        error: `Search failed: ${(err as Error).message}`,
        metadata: { query },
      };
    } finally {
      clearTimeout(timeoutId);
      context.abortSignal.removeEventListener('abort', onContextAbort);
      this.abortController = null;
    }
  }

  abort(_reason: string): void {
    this.abortController?.abort();
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatSearchResults(
  results: BraveWebResult[],
  queryInfo?: BraveSearchResponse['query'],
): string {
  if (results.length === 0) {
    return 'No search results found.';
  }

  const lines: string[] = [];

  // Note if the query was altered (spell correction, etc.).
  if (queryInfo?.altered && queryInfo.altered !== queryInfo.original) {
    lines.push(`Showing results for: "${queryInfo.altered}" (original: "${queryInfo.original}")\n`);
  }

  lines.push(`Found ${results.length} result${results.length === 1 ? '' : 's'}:\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    URL: ${r.url}`);
    if (r.description) {
      lines.push(`    ${r.description}`);
    }
    if (r.age) {
      lines.push(`    Age: ${r.age}`);
    }
    if (r.extra_snippets && r.extra_snippets.length > 0) {
      lines.push(`    Snippets: ${r.extra_snippets.join(' | ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
