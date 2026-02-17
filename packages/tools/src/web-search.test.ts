/**
 * Tests for WebSearchTool — Brave Search API integration.
 *
 * All fetch calls are mocked. Tests verify validation, result formatting,
 * error handling, abort support, and output truncation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '@ch4p/core';
import { WebSearchTool } from './web-search.js';
import type { SearchToolContext } from './web-search.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSearchContext(overrides: Partial<SearchToolContext> = {}): SearchToolContext {
  return {
    sessionId: 'test-session',
    cwd: '/tmp/ch4p-test',
    securityPolicy: {
      validatePath: vi.fn().mockReturnValue({ allowed: true, canonicalPath: undefined }),
      validateCommand: vi.fn().mockReturnValue({ allowed: true }),
      autonomyLevel: 'full' as const,
      requiresConfirmation: vi.fn().mockReturnValue(false),
      audit: vi.fn().mockReturnValue([]),
      sanitizeOutput: vi.fn().mockImplementation((text: string) => ({
        clean: text,
        redacted: false,
      })),
    },
    abortSignal: new AbortController().signal,
    onProgress: vi.fn(),
    searchApiKey: 'test-brave-api-key',
    searchConfig: { maxResults: 5 },
    ...overrides,
  };
}

/** Mock Brave Search API response. */
function createMockBraveResponse(results: Array<{
  title: string;
  url: string;
  description: string;
  age?: string;
  extra_snippets?: string[];
}> = []) {
  return {
    web: { results },
    query: { original: 'test query' },
  };
}

const DEFAULT_RESULTS = [
  {
    title: 'TypeScript Documentation',
    url: 'https://www.typescriptlang.org/docs/',
    description: 'Official TypeScript documentation and handbook.',
    age: '3 days ago',
  },
  {
    title: 'TypeScript GitHub Repository',
    url: 'https://github.com/microsoft/TypeScript',
    description: 'TypeScript is a superset of JavaScript that compiles to clean JS output.',
    extra_snippets: ['Stars: 95k', 'Latest release: v5.4'],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSearchTool', () => {
  let tool: WebSearchTool;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new WebSearchTool();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Tool metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('has correct name', () => {
      expect(tool.name).toBe('web_search');
    });

    it('is classified as heavyweight', () => {
      expect(tool.weight).toBe('heavyweight');
    });

    it('has a description', () => {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    });

    it('requires query parameter', () => {
      expect(tool.parameters.required).toContain('query');
    });
  });

  // -------------------------------------------------------------------------
  // validate()
  // -------------------------------------------------------------------------

  describe('validate()', () => {
    it('accepts a valid query', () => {
      const result = tool.validate({ query: 'typescript best practices' });
      expect(result.valid).toBe(true);
    });

    it('rejects null args', () => {
      const result = tool.validate(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Arguments must be an object.');
    });

    it('rejects missing query', () => {
      const result = tool.validate({});
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toMatch(/query/);
    });

    it('rejects empty query', () => {
      const result = tool.validate({ query: '' });
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toMatch(/query/);
    });

    it('rejects whitespace-only query', () => {
      const result = tool.validate({ query: '   ' });
      expect(result.valid).toBe(false);
    });

    it('rejects query exceeding 2000 chars', () => {
      const result = tool.validate({ query: 'x'.repeat(2001) });
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toMatch(/2000/);
    });

    it('accepts valid count', () => {
      const result = tool.validate({ query: 'test', count: 10 });
      expect(result.valid).toBe(true);
    });

    it('rejects count below 1', () => {
      const result = tool.validate({ query: 'test', count: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toMatch(/count/);
    });

    it('rejects count above 20', () => {
      const result = tool.validate({ query: 'test', count: 21 });
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toMatch(/count/);
    });

    it('rejects non-integer count', () => {
      const result = tool.validate({ query: 'test', count: 5.5 });
      expect(result.valid).toBe(false);
    });

    it('accepts valid freshness values', () => {
      for (const f of ['pd', 'pw', 'pm', 'py']) {
        expect(tool.validate({ query: 'test', freshness: f }).valid).toBe(true);
      }
    });

    it('rejects invalid freshness', () => {
      const result = tool.validate({ query: 'test', freshness: 'invalid' });
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toMatch(/freshness/);
    });

    it('accepts valid offset', () => {
      const result = tool.validate({ query: 'test', offset: 10 });
      expect(result.valid).toBe(true);
    });

    it('rejects negative offset', () => {
      const result = tool.validate({ query: 'test', offset: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toMatch(/offset/);
    });

    it('accepts valid country', () => {
      const result = tool.validate({ query: 'test', country: 'US' });
      expect(result.valid).toBe(true);
    });

    it('rejects empty country', () => {
      const result = tool.validate({ query: 'test', country: '' });
      expect(result.valid).toBe(false);
    });

    it('accumulates multiple validation errors', () => {
      const result = tool.validate({ query: '', count: 100, freshness: 'bad' });
      expect(result.valid).toBe(false);
      expect(result.errors!.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  // execute() — success
  // -------------------------------------------------------------------------

  describe('execute() — success', () => {
    it('returns formatted search results', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockBraveResponse(DEFAULT_RESULTS),
      });

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'typescript' }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Found 2 results');
      expect(result.output).toContain('[1] TypeScript Documentation');
      expect(result.output).toContain('URL: https://www.typescriptlang.org/docs/');
      expect(result.output).toContain('Official TypeScript documentation');
      expect(result.output).toContain('[2] TypeScript GitHub Repository');
      expect(result.output).toContain('Age: 3 days ago');
      expect(result.output).toContain('Stars: 95k');
    });

    it('includes correct metadata', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockBraveResponse(DEFAULT_RESULTS),
      });

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'typescript' }, ctx);

      expect(result.metadata).toEqual({
        query: 'typescript',
        provider: 'brave',
        resultCount: 2,
        offset: 0,
      });
    });

    it('calls progress callback', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockBraveResponse([]),
      });

      const ctx = createSearchContext();
      await tool.execute({ query: 'test' }, ctx);

      expect(ctx.onProgress).toHaveBeenCalledWith('Searching for "test"...');
    });

    it('sends correct headers to Brave API', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockBraveResponse([]),
      });

      const ctx = createSearchContext();
      await tool.execute({ query: 'test' }, ctx);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];

      expect(url).toContain('api.search.brave.com');
      expect(url).toContain('q=test');
      expect((opts.headers as Record<string, string>)['X-Subscription-Token']).toBe('test-brave-api-key');
    });

    it('passes count and freshness as query params', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockBraveResponse([]),
      });

      const ctx = createSearchContext();
      await tool.execute({ query: 'test', count: 10, freshness: 'pw' }, ctx);

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('count=10');
      expect(url).toContain('freshness=pw');
    });

    it('returns "No search results found" for empty results', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockBraveResponse([]),
      });

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'xyznonexistent123' }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toBe('No search results found.');
    });

    it('uses searchConfig defaults for count and country', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockBraveResponse([]),
      });

      const ctx = createSearchContext({
        searchConfig: { maxResults: 8, country: 'DE', searchLang: 'de' },
      });
      await tool.execute({ query: 'test' }, ctx);

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('count=8');
      expect(url).toContain('country=DE');
      expect(url).toContain('search_lang=de');
    });
  });

  // -------------------------------------------------------------------------
  // execute() — API key handling
  // -------------------------------------------------------------------------

  describe('execute() — API key', () => {
    it('returns clear error when searchApiKey is missing', async () => {
      const ctx = createSearchContext({ searchApiKey: undefined });
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Search API key is not configured/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // execute() — HTTP errors
  // -------------------------------------------------------------------------

  describe('execute() — HTTP errors', () => {
    it('handles 401 unauthorized', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid or expired/);
    });

    it('handles 403 forbidden', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid or expired/);
    });

    it('handles 429 rate limit', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/rate limit/i);
    });

    it('handles 500 server error', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/HTTP 500/);
    });

    it('handles network errors', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network request failed'));

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Search failed/);
      expect(result.error).toContain('Network request failed');
    });
  });

  // -------------------------------------------------------------------------
  // execute() — abort handling
  // -------------------------------------------------------------------------

  describe('execute() — abort', () => {
    it('returns error when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const ctx = createSearchContext({ abortSignal: controller.signal });
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/aborted/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns aborted when context signal fires mid-request', async () => {
      const controller = new AbortController();
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      fetchSpy.mockImplementationOnce(async () => {
        controller.abort();
        throw abortError;
      });

      const ctx = createSearchContext({ abortSignal: controller.signal });
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/aborted/i);
    });

    it('supports abort() method', () => {
      // Just verifying the method exists and doesn't throw.
      expect(() => tool.abort('test reason')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // execute() — output truncation
  // -------------------------------------------------------------------------

  describe('execute() — output truncation', () => {
    it('truncates output exceeding MAX_OUTPUT_LENGTH', async () => {
      const longResults = Array.from({ length: 20 }, (_, i) => ({
        title: `Result ${i + 1}: ${'x'.repeat(2000)}`,
        url: `https://example.com/${i}`,
        description: 'y'.repeat(3000),
      }));

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockBraveResponse(longResults),
      });

      const ctx = createSearchContext();
      const result = await tool.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(true);
      // 50,000 chars max + truncation suffix
      expect(result.output.length).toBeLessThanOrEqual(50_100);
      expect(result.output).toContain('... [results truncated] ...');
    });
  });

  // -------------------------------------------------------------------------
  // execute() — validation passthrough
  // -------------------------------------------------------------------------

  describe('execute() — validation passthrough', () => {
    it('returns error for invalid args without calling fetch', async () => {
      const ctx = createSearchContext();
      const result = await tool.execute({ query: '' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid arguments/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
