import dns from 'dns';
import net from 'net';
import { Agent } from 'undici';

export interface UrlValidationResult {
  isValid: boolean;
  normalizedUrl?: string;
  error?: string;
  resolvedIps?: string[];
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

export interface SafeFetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
}

const FORBIDDEN_PROTOCOLS = new Set([
  'file:',
  'ftp:',
  'gopher:',
  'javascript:',
  'data:',
  'blob:',
  'ws:',
  'wss:',
  'ldap:',
  'mailto:'
]);

/**
 * Checks if an IPv4 address belongs to a private, loopback, link-local, or reserved subnet.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed is considered unsafe
  }

  const [b0, b1, b2, b3] = parts;

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;

  // 10.0.0.0/8 (Private)
  if (b0 === 10) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 169.254.0.0/16 (Link-local / Cloud Metadata: AWS/GCP/Azure 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.168.0.0/16 (Private)
  if (b0 === 192 && b1 === 168) return true;

  // 100.64.0.0/10 (Carrier-grade NAT: 100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 192.0.0.0/24 & 192.0.2.0/24 (IETF Protocol Assignments & TEST-NET-1)
  if (b0 === 192 && b1 === 0 && (b2 === 0 || b2 === 2)) return true;

  // 198.18.0.0/15 (Benchmarking: 198.18.0.0 - 198.19.255.255)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 (Reserved for future use: 240.0.0.0 - 255.255.255.254)
  if (b0 >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (b0 === 255 && b1 === 255 && b2 === 255 && b3 === 255) return true;

  return false;
}

/**
 * Checks if an IPv6 address belongs to a loopback, unique local, link-local, or mapped IPv4 private subnet.
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // ::1 (Loopback)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // :: (Unspecified)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // IPv4-mapped IPv6. WHATWG URL canonicalizes dotted literals like
  // ::ffff:127.0.0.1 into hexadecimal form ::ffff:7f00:1, so handle both.
  const mappedPrefix = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized.startsWith('0:0:0:0:0:ffff:')
      ? normalized.slice('0:0:0:0:0:ffff:'.length)
      : null;
  if (mappedPrefix !== null) {
    if (net.isIPv4(mappedPrefix)) return isPrivateIPv4(mappedPrefix);
    const halves = mappedPrefix.split(':');
    if (halves.length !== 2 || halves.some(part => !/^[0-9a-f]{1,4}$/.test(part))) {
      return true; // Malformed mapped address is unsafe.
    }
    const high = Number.parseInt(halves[0], 16);
    const low = Number.parseInt(halves[1], 16);
    const mappedIPv4 = [
      (high >> 8) & 255, high & 255,
      (low >> 8) & 255, low & 255
    ].join('.');
    return isPrivateIPv4(mappedIPv4);
  }

  // IPv4-compatible / other all-zero-prefix IPv6 forms are deprecated and
  // can disguise loopback or reserved IPv4 destinations after URL normalization.
  if (normalized.startsWith('::') || normalized.startsWith('0:0:0:0:0:0:')) {
    return true;
  }

  // fc00::/7 (Unique Local Address: fc00:: to fdff::)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // fe80::/10 (Link-Local Unicast: fe80:: to febf::)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  // ff00::/8 (Multicast)
  if (normalized.startsWith('ff')) return true;

  return false;
}

/**
 * Validates whether an IP address (IPv4 or IPv6) is considered private or reserved.
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return isPrivateIPv4(ip);
  }
  if (net.isIPv6(ip)) {
    return isPrivateIPv6(ip);
  }
  return true; // Non-IP or invalid string treated as unsafe
}

/**
 * Strips tracking parameters, URL fragments, and normalizes a URL for deduplication.
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    // Remove query parameters commonly used for tracking
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      '_ga',
      'ref',
      'referrer',
      'source'
    ];
    for (const p of trackingParams) {
      parsed.searchParams.delete(p);
    }
    parsed.hash = ''; // Remove fragment

    // Strip trailing slash on path if length > 1
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Validates a user-supplied URL against syntax, protocol, and SSRF restrictions.
 * Performs DNS resolution to detect internal IP bindings before any network connection is made.
 */
export async function validateUrlSecurity(rawUrl: string): Promise<UrlValidationResult> {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { isValid: false, error: 'URL is required.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { isValid: false, error: 'Invalid URL format. Please provide a valid HTTP or HTTPS address.' };
  }

  // 1. Protocol check
  const protocol = parsed.protocol.toLowerCase();
  if (FORBIDDEN_PROTOCOLS.has(protocol)) {
    return {
      isValid: false,
      error: `Security violation: Protocol '${protocol}' is forbidden. Only HTTP and HTTPS are permitted.`
    };
  }

  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      isValid: false,
      error: `Unsupported protocol: '${protocol}'. Only HTTP and HTTPS are allowed.`
    };
  }

  // Credentials can obscure the intended host and are not needed for public news.
  if (parsed.username || parsed.password) {
    return { isValid: false, error: 'URLs containing usernames or passwords are not permitted.' };
  }
  const allowedPort = protocol === 'https:' ? '443' : '80';
  if (parsed.port && parsed.port !== allowedPort) {
    return { isValid: false, error: 'Only standard HTTP (80) and HTTPS (443) ports are permitted.' };
  }

  // Normalize bracketed IPv6 literals before all address checks and DNS lookup.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    return { isValid: false, error: 'URL must contain a valid hostname.' };
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    return { isValid: false, error: 'Access to localhost and internal loopback addresses is blocked.' };
  }

  // 3. Direct IP address check
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return {
        isValid: false,
        error: `SSRF protection: Direct connection to private or reserved IP (${hostname}) is blocked.`
      };
    }
  }

  // 4. DNS Pre-flight lookup to prevent DNS-rebinding SSRF
  try {
    const lookupResults = await dns.promises.lookup(hostname, { all: true });
    if (!lookupResults || lookupResults.length === 0) {
      return { isValid: false, error: `Could not resolve domain name: ${hostname}` };
    }

    const resolvedIps = lookupResults.map((r) => r.address);
    for (const res of lookupResults) {
      if (isPrivateIp(res.address)) {
        return {
          isValid: false,
          error: `SSRF protection: Domain '${hostname}' resolves to private/internal IP address (${res.address}). Access denied.`
        };
      }
    }

    return {
      isValid: true,
      normalizedUrl: normalizeUrl(parsed.toString()),
      resolvedIps
    };
  } catch (err: any) {
    return {
      isValid: false,
      error: `DNS resolution failed for '${hostname}': ${err.message || 'Domain not found'}`
    };
  }
}

/**
 * Safely fetches a webpage with SSRF revalidation on redirects, strict timeout,
 * maximum response byte limit, and content-type verification.
 */
export async function safeFetchHtml(
  targetUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 12000;
  const maxBytes = options.maxBytes ?? 2.5 * 1024 * 1024; // 2.5 MB maximum
  const maxRedirects = options.maxRedirects ?? 5;
  // Use a normal browser UA by default. Some publishers reject generic bot UAs
  // even when the page is publicly accessible. This does not bypass authentication
  // or robots/paywall controls; it only makes the request look like a normal page load.
  const userAgent =
    options.userAgent ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

  let currentUrl = targetUrl;
  let redirectsFollowed = 0;

  while (redirectsFollowed <= maxRedirects) {
    // Resolve and inspect every redirect destination, then pin the actual socket
    // lookup to this exact allow-listed result to close the DNS-rebinding gap.
    const validation = await validateUrlSecurity(currentUrl);
    if (!validation.isValid) {
      throw new Error(validation.error || `Security check failed for URL: ${currentUrl}`);
    }
    const parsedUrl = new URL(currentUrl);
    const normalizedHost = parsedUrl.hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
    const validatedAddresses = (validation.resolvedIps || [])
      .map(address => ({ address, family: net.isIP(address) }))
      .filter((entry) => entry.family === 4 || entry.family === 6);
    if (validatedAddresses.length === 0) {
      throw new Error(`DNS resolution failed for '${normalizedHost}': no validated public address was available.`);
    }
    const pinnedLookup = ((hostname: string, lookupOptions: any, callback: any) => {
      const requestedHost = hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
      if (requestedHost !== normalizedHost) {
        return callback(new Error('Connection hostname differed from the validated URL.'), '', 0);
      }
      const family = typeof lookupOptions === 'number' ? lookupOptions : lookupOptions?.family;
      const candidates = validatedAddresses.filter((entry) => !family || family === 0 || entry.family === family);
      if (candidates.length === 0) {
        return callback(new Error('No validated address matched the requested address family.'), '', 0);
      }
      if (lookupOptions && typeof lookupOptions === 'object' && lookupOptions.all) {
        callback(null, candidates);
      } else {
        callback(null, candidates[0].address, candidates[0].family);
      }
    }) as any;
    const dispatcher = new Agent({ connections: 1, connect: { lookup: pinnedLookup } });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none'
          },
          redirect: 'manual',
          signal: controller.signal,
          // node's fetch supports Undici dispatchers. Test doubles may ignore this option.
          dispatcher
        } as any);
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError') {
          throw new Error(`Connection timed out after ${timeoutMs / 1000}s while fetching ${currentUrl}`);
        }
        throw new Error(`Failed to establish connection to ${currentUrl}: ${fetchErr?.message || 'network error'}`);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Received HTTP ${response.status} redirect without a Location header.`);
        redirectsFollowed++;
        if (redirectsFollowed > maxRedirects) throw new Error(`Maximum redirect limit (${maxRedirects}) exceeded.`);
        try { currentUrl = new URL(location, currentUrl).toString(); }
        catch { throw new Error(`Malformed redirect Location header: ${location}`); }
        continue;
      }
      if (response.status === 403) throw new Error('Access forbidden (HTTP 403): The target website blocked the extraction request.');
      if (response.status === 404) throw new Error('Article not found (HTTP 404): The requested URL does not exist.');
      if (response.status === 429) throw new Error('Rate limited by publisher (HTTP 429): Too many requests to the target website.');
      if (response.status >= 400) throw new Error(`HTTP error ${response.status}: Failed to retrieve article from target server.`);

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
      if (!isHtml) {
        throw new Error(`Unsupported content type '${contentType || 'unknown'}'. TruthLens AI only processes HTML news web pages, not binaries, media, or PDFs.`);
      }
      if (!response.body) throw new Error('Server returned empty response body.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.length;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`Article exceeds maximum allowed payload size of ${(maxBytes / (1024 * 1024)).toFixed(1)} MB.`);
          }
          chunks.push(value);
        }
      }
      const totalBuffer = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) { totalBuffer.set(chunk, offset); offset += chunk.length; }
      const html = new TextDecoder('utf-8').decode(totalBuffer);
      return { html, finalUrl: currentUrl, statusCode: response.status, contentType };
    } finally {
      clearTimeout(timeoutId);
      await dispatcher.destroy().catch(() => {});
    }
  }

  throw new Error(`Exceeded maximum redirect limit (${maxRedirects}).`);
}
