/**
 * WebFetch tool — fetches URL content with HTML-to-text conversion.
 *
 * Heavyweight tool that retrieves web content via HTTP(S). Performs basic
 * HTML-to-text conversion (strip tags, decode entities). Supports timeout
 * and response size limits.
 *
 * Security: SSRF guards block requests to private/reserved IP ranges,
 * cloud metadata endpoints, and localhost. DNS resolution is validated
 * before connecting. Redirects are followed manually with SSRF checks
 * at each hop.
 */

import type {
  ITool,
  ToolContext,
  ToolResult,
  ValidationResult,
  JSONSchema7,
} from '@ch4p/core';
import { resolve4, resolve6 } from 'node:dns/promises';
// ToolError available from @ch4p/core if needed

interface WebFetchArgs {
  url: string;
  prompt?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_OUTPUT_LENGTH = 50_000;
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// SSRF protection helpers
// ---------------------------------------------------------------------------

/** Hostnames that must never be reached (cloud metadata services). */
const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',           // AWS / GCP / Azure instance metadata
  'metadata.google.internal',  // GCP metadata alternative
  'metadata.internal',         // Generic cloud metadata
]);

/**
 * Check whether an IPv4 address falls in a private or reserved range.
 *
 * Blocked ranges:
 *   127.0.0.0/8        loopback
 *   10.0.0.0/8         Class A private
 *   172.16.0.0/12      Class B private
 *   192.168.0.0/16     Class C private
 *   169.254.0.0/16     link-local
 *   0.0.0.0/8          "this" network
 *   100.64.0.0/10      shared address space (RFC 6598)
 *   192.0.0.0/24       IANA special purpose
 *   192.0.2.0/24       documentation (TEST-NET-1)
 *   198.51.100.0/24    documentation (TEST-NET-2)
 *   203.0.113.0/24     documentation (TEST-NET-3)
 *   224.0.0.0/4        multicast
 *   240.0.0.0/4        reserved
 */
function isPrivateIpV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed — treat as blocked.
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return true;                         // 127.0.0.0/8
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10
  if (a === 192 && b === 0) return true;               // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && b === 51) return true;              // 198.51.100.0/24
  if (a === 203 && b === 0) return true;               // 203.0.113.0/24
  if (a >= 224) return true;                           // 224.0.0.0/4 + 240.0.0.0/4

  return false;
}

/**
 * Check whether an IPv6 address is private/reserved.
 *
 * Blocked:  ::1 (loopback), fe80::/10 (link-local), fc00::/7 (ULA),
 *           :: (unspecified), ::ffff:0:0/96 (IPv4-mapped — re-check the v4 part).
 */
function isPrivateIpV6(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true;   // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) {
    return isPrivateIpV4(v4Mapped[1]!);
  }

  return false;
}

/**
 * Synchronous check: does the URL hostname point to a blocked host?
 * Catches IP-literal hostnames and well-known metadata hostnames.
 */
function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (hostname === 'localhost') return true;

  // Direct IPv4 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isPrivateIpV4(hostname);
  }

  // IPv6 literal (brackets stripped by URL parser)
  if (hostname.includes(':')) {
    return isPrivateIpV6(hostname);
  }

  return false;
}

/**
 * Async check: resolve the hostname via DNS and verify none of the
 * resolved addresses are private or reserved.
 */
async function resolveAndCheckPrivate(hostname: string): Promise<{ blocked: boolean; reason?: string }> {
  // Skip DNS resolution for IP literals — already checked synchronously.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return { blocked: false };
  }

  try {
    const [v4Addrs, v6Addrs] = await Promise.all([
      resolve4(hostname).catch(() => [] as string[]),
      resolve6(hostname).catch(() => [] as string[]),
    ]);

    for (const addr of v4Addrs) {
      if (isPrivateIpV4(addr)) {
        return { blocked: true, reason: `DNS resolved to private IPv4 address ${addr}` };
      }
    }
    for (const addr of v6Addrs) {
      if (isPrivateIpV6(addr)) {
        return { blocked: true, reason: `DNS resolved to private IPv6 address ${addr}` };
      }
    }

    // If DNS resolved to zero addresses, the hostname doesn't exist.
    if (v4Addrs.length === 0 && v6Addrs.length === 0) {
      return { blocked: true, reason: `DNS resolution failed for ${hostname}` };
    }

    return { blocked: false };
  } catch {
    return { blocked: true, reason: `DNS resolution failed for ${hostname}` };
  }
}

// ---------------------------------------------------------------------------
// WebFetchTool
// ---------------------------------------------------------------------------

export class WebFetchTool implements ITool {
  readonly name = 'web_fetch';
  readonly description =
    'Fetch content from a URL. HTML is converted to plain text. ' +
    'Supports HTTP and HTTPS. An optional prompt can describe what ' +
    'information to focus on in the response.';

  readonly weight = 'heavyweight' as const;

  readonly parameters: JSONSchema7 = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from. Must be a valid HTTP or HTTPS URL.',
        format: 'uri',
        minLength: 1,
      },
      prompt: {
        type: 'string',
        description:
          'Optional prompt describing what information to extract from the page.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  };

  private abortController: AbortController | null = null;

  validate(args: unknown): ValidationResult {
    if (typeof args !== 'object' || args === null) {
      return { valid: false, errors: ['Arguments must be an object.'] };
    }

    const { url, prompt } = args as Record<string, unknown>;
    const errors: string[] = [];

    if (typeof url !== 'string' || url.trim().length === 0) {
      errors.push('url must be a non-empty string.');
    }

    if (typeof url === 'string') {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push('url must use http or https protocol.');
        }

        // Synchronous SSRF check on the hostname.
        if (isBlockedHostname(parsed.hostname)) {
          errors.push('url targets a blocked or private network address.');
        }
      } catch {
        errors.push('url must be a valid URL.');
      }
    }

    if (prompt !== undefined && typeof prompt !== 'string') {
      errors.push('prompt must be a string.');
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

    const { url, prompt } = args as WebFetchArgs;

    // Upgrade http to https
    let fetchUrl = url.replace(/^http:\/\//, 'https://');

    if (context.abortSignal.aborted) {
      return {
        success: false,
        output: '',
        error: 'Request aborted before execution.',
      };
    }

    // Async SSRF check: resolve DNS and verify the resolved IPs are not private.
    try {
      const parsed = new URL(fetchUrl);
      const dnsCheck = await resolveAndCheckPrivate(parsed.hostname);
      if (dnsCheck.blocked) {
        return {
          success: false,
          output: '',
          error: `SSRF blocked: ${dnsCheck.reason}`,
          metadata: { url: fetchUrl, ssrfBlocked: true },
        };
      }
    } catch {
      return {
        success: false,
        output: '',
        error: 'Failed to parse URL for SSRF check.',
        metadata: { url: fetchUrl },
      };
    }

    // Create our own abort controller that chains with the context signal
    this.abortController = new AbortController();
    const onContextAbort = () => this.abortController?.abort();
    context.abortSignal.addEventListener('abort', onContextAbort, { once: true });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, DEFAULT_TIMEOUT_MS);

    try {
      context.onProgress(`Fetching ${fetchUrl}...`);

      // Manual redirect following with SSRF validation at each hop.
      let response: Response | null = null;
      let redirectCount = 0;

      while (redirectCount <= MAX_REDIRECTS) {
        response = await fetch(fetchUrl, {
          signal: this.abortController.signal,
          headers: {
            'User-Agent': 'ch4p/0.1.0',
            Accept: 'text/html, application/json, text/plain, */*',
          },
          redirect: 'manual', // We follow redirects ourselves for SSRF safety.
        });

        // Check for redirect responses.
        const status = response.status;
        if (status >= 300 && status < 400) {
          const location = response.headers.get('location');
          if (!location) break; // No location header — stop following.

          // Resolve relative URLs against the current URL.
          const redirectUrl = new URL(location, fetchUrl).toString();
          const redirectParsed = new URL(redirectUrl);

          // SSRF check on each redirect target.
          if (isBlockedHostname(redirectParsed.hostname)) {
            return {
              success: false,
              output: '',
              error: `SSRF blocked: redirect to private/blocked address ${redirectParsed.hostname}`,
              metadata: { url: fetchUrl, redirectUrl, ssrfBlocked: true },
            };
          }

          const redirectDns = await resolveAndCheckPrivate(redirectParsed.hostname);
          if (redirectDns.blocked) {
            return {
              success: false,
              output: '',
              error: `SSRF blocked on redirect: ${redirectDns.reason}`,
              metadata: { url: fetchUrl, redirectUrl, ssrfBlocked: true },
            };
          }

          fetchUrl = redirectUrl;
          redirectCount++;
          continue;
        }

        break; // Not a redirect — we have our final response.
      }

      if (!response) {
        return {
          success: false,
          output: '',
          error: 'Failed to obtain a response.',
          metadata: { url: fetchUrl },
        };
      }

      if (redirectCount > MAX_REDIRECTS) {
        return {
          success: false,
          output: '',
          error: `Too many redirects (${MAX_REDIRECTS} max).`,
          metadata: { url: fetchUrl, redirectCount },
        };
      }

      if (!response.ok) {
        return {
          success: false,
          output: '',
          error: `HTTP ${response.status}: ${response.statusText}`,
          metadata: {
            url: fetchUrl,
            status: response.status,
            statusText: response.statusText,
          },
        };
      }

      // Check content length before reading body
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        return {
          success: false,
          output: '',
          error: `Response too large: ${contentLength} bytes (limit: ${MAX_RESPONSE_SIZE}).`,
          metadata: { url: fetchUrl, contentLength: parseInt(contentLength, 10) },
        };
      }

      const contentType = response.headers.get('content-type') ?? '';
      const body = await response.text();

      if (body.length > MAX_RESPONSE_SIZE) {
        return {
          success: false,
          output: '',
          error: `Response body too large: ${body.length} bytes (limit: ${MAX_RESPONSE_SIZE}).`,
          metadata: { url: fetchUrl, size: body.length },
        };
      }

      let textContent: string;

      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        textContent = htmlToText(body);
      } else if (contentType.includes('application/json')) {
        try {
          const json = JSON.parse(body);
          textContent = JSON.stringify(json, null, 2);
        } catch {
          textContent = body;
        }
      } else {
        textContent = body;
      }

      // Truncate output if necessary
      if (textContent.length > MAX_OUTPUT_LENGTH) {
        textContent =
          textContent.slice(0, MAX_OUTPUT_LENGTH) +
          '\n\n... [content truncated] ...';
      }

      let output = textContent;
      if (prompt) {
        output = `[Prompt: ${prompt}]\n\n${textContent}`;
      }

      return {
        success: true,
        output,
        metadata: {
          url: fetchUrl,
          status: response.status,
          contentType,
          size: body.length,
          truncated: textContent.length > MAX_OUTPUT_LENGTH,
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
          error: `Request timed out after ${DEFAULT_TIMEOUT_MS}ms.`,
          metadata: { url: fetchUrl, timedOut: true },
        };
      }

      return {
        success: false,
        output: '',
        error: `Fetch failed: ${(err as Error).message}`,
        metadata: { url: fetchUrl },
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

/**
 * Basic HTML-to-text conversion.
 * Strips HTML tags, decodes common entities, collapses whitespace,
 * and preserves basic structural formatting.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Replace block-level elements with newlines
  text = text.replace(/<\/?(p|div|br|hr|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|pre|section|article|header|footer|nav|main|aside|figure|figcaption)\b[^>]*\/?>/gi, '\n');

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Collapse whitespace while preserving newlines
  text = text.replace(/[^\S\n]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** Decode common HTML entities. */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&mdash;': '\u2014',
    '&ndash;': '\u2013',
    '&laquo;': '\u00AB',
    '&raquo;': '\u00BB',
    '&bull;': '\u2022',
    '&hellip;': '\u2026',
    '&copy;': '\u00A9',
    '&reg;': '\u00AE',
    '&trade;': '\u2122',
  };

  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }

  // Decode numeric entities (&#NNN; and &#xHHH;)
  result = result.replace(/&#(\d+);/g, (_, code) => {
    const num = parseInt(code, 10);
    return num > 0 && num < 0x110000 ? String.fromCodePoint(num) : '';
  });
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
    const num = parseInt(code, 16);
    return num > 0 && num < 0x110000 ? String.fromCodePoint(num) : '';
  });

  return result;
}
