import dns from 'dns';
import net from 'net';

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

  // IPv4-mapped IPv6: ::ffff:192.0.2.128 or ::ffff:c000:0280
  if (normalized.startsWith('::ffff:') || normalized.startsWith('0:0:0:0:0:ffff:')) {
    const lastPart = normalized.substring(normalized.lastIndexOf(':') + 1);
    if (net.isIPv4(lastPart)) {
      return isPrivateIPv4(lastPart);
    }
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

  // 2. Hostname sanity check
  const hostname = parsed.hostname.toLowerCase();
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
  const userAgent =
    options.userAgent ??
    'TruthLens-Bot/1.0 (+https://truthlens.ai/bot; News Article Risk Extractor)';

  let currentUrl = targetUrl;
  let redirectsFollowed = 0;

  while (redirectsFollowed <= maxRedirects) {
    // Re-validate every hop against SSRF rules
    const validation = await validateUrlSecurity(currentUrl);
    if (!validation.isValid) {
      throw new Error(validation.error || `Security check failed for URL: ${currentUrl}`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'manual', // Never let node auto-follow without validation
        signal: controller.signal
      });
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        throw new Error(`Connection timed out after ${timeoutMs / 1000}s while fetching ${currentUrl}`);
      }
      throw new Error(`Failed to establish connection to ${currentUrl}: ${fetchErr.message}`);
    }

    clearTimeout(timeoutId);

    // Handle redirects manually
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Received HTTP ${response.status} redirect without a Location header.`);
      }

      redirectsFollowed++;
      if (redirectsFollowed > maxRedirects) {
        throw new Error(`Maximum redirect limit (${maxRedirects}) exceeded.`);
      }

      // Resolve relative redirect against current URL
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new Error(`Malformed redirect Location header: ${location}`);
      }
      continue;
    }

    // Check status code
    if (response.status === 403) {
      throw new Error(`Access forbidden (HTTP 403): The target website blocked the extraction request.`);
    }
    if (response.status === 404) {
      throw new Error(`Article not found (HTTP 404): The requested URL does not exist.`);
    }
    if (response.status === 429) {
      throw new Error(`Rate limited by publisher (HTTP 429): Too many requests to the target website.`);
    }
    if (response.status >= 400) {
      throw new Error(`HTTP error ${response.status}: Failed to retrieve article from target server.`);
    }

    // Check Content-Type
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isHtml =
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml+xml');

    if (!isHtml) {
      throw new Error(
        `Unsupported content type '${contentType || 'unknown'}'. TruthLens AI only processes HTML news web pages, not binaries, media, or PDFs.`
      );
    }

    // Stream response with byte count guard
    if (!response.body) {
      throw new Error('Server returned empty response body.');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          reader.cancel();
          throw new Error(
            `Article exceeds maximum allowed payload size of ${(maxBytes / (1024 * 1024)).toFixed(1)} MB.`
          );
        }
        chunks.push(value);
      }
    }

    // Combine chunks
    const totalBuffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      totalBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    const decoder = new TextDecoder('utf-8');
    const html = decoder.decode(totalBuffer);

    return {
      html,
      finalUrl: currentUrl,
      statusCode: response.status,
      contentType
    };
  }

  throw new Error(`Exceeded maximum redirect limit (${maxRedirects}).`);
}
