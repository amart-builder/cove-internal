/**
 * Local HTTP request boundary shared by Cove's API routes.
 *
 * Host and Origin validation prevent DNS rebinding and unsafe proxy forwarding.
 * They are not user authentication. Loopback mode is safe only when the server
 * is actually bound to loopback or reached through an already-authenticated
 * local proxy. Mutating routes layer Cove's CSRF token on top of this check.
 */
import { timingSafeEqual } from 'node:crypto';
import { coveEnv } from "./env";

export type TrustedOriginInput = {
  origin?: string | null;
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  requestProtocol?: string | null;
  allowedHosts?: string[];
  trustProxy?: boolean;
};

type RequestLike = {
  headers: { get(name: string): string | null };
  nextUrl: { host: string; protocol: string };
};

export type DayPlanAccessMode = 'loopback' | 'session';
const LOOPBACK_ACCESS_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

type CoveHostEnvironment = {
  [key: string]: string | undefined;
  COVE_PUBLIC_URL?: string;
  COVE_TAILSCALE_TRUSTED_HOSTS?: string;
  COVE_ALLOWED_HOSTS?: string;
  COVE_TRUST_PROXY?: string;
  // The pre-rename spellings. Read through coveEnv, never directly.
  FORGE_PUBLIC_URL?: string;
  FORGE_TAILSCALE_TRUSTED_HOSTS?: string;
  FORGE_ALLOWED_HOSTS?: string;
  FORGE_TRUST_PROXY?: string;
};

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function firstHeaderValue(value?: string | null): string | undefined {
  const first = value?.split(',')[0]?.trim();
  return first || undefined;
}

function normalizedProtocol(value?: string | null): string | undefined {
  const protocol = firstHeaderValue(value)?.toLowerCase();
  if (!protocol) return undefined;
  return protocol.endsWith(':') ? protocol : `${protocol}:`;
}

function normalizedAllowedHost(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) return undefined;
  try {
    const url = candidate.includes('://')
      ? new URL(candidate)
      : new URL(`http://${candidate}`);
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostParts(value: string): { hostname: string; port: string } | undefined {
  try {
    const url = new URL(`http://${value}`);
    return { hostname: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return undefined;
  }
}

function isAllowedHost(publicHost: string, allowedHosts: string[]): boolean {
  const requested = hostParts(publicHost);
  if (!requested) return false;

  return allowedHosts.some((entry) => {
    const normalized = normalizedAllowedHost(entry);
    if (!normalized) return false;
    const allowed = hostParts(normalized);
    if (!allowed || requested.hostname !== allowed.hostname) return false;
    return !allowed.port || requested.port === allowed.port;
  });
}

export function getCoveAllowedHosts(
  environment: CoveHostEnvironment = process.env,
): string[] {
  const configured = [
    coveEnv('PUBLIC_URL', environment),
    coveEnv('TAILSCALE_TRUSTED_HOSTS', environment),
    coveEnv('ALLOWED_HOSTS', environment),
  ]
    .flatMap((value) => value?.split(',') ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  return [...LOOPBACK_HOSTS, ...configured];
}

/**
 * Validates both the public request host and, when present, the browser Origin.
 * The allowlist prevents DNS rebinding while Host-based comparison lets Cove
 * work through loopback aliases and trusted reverse proxies.
 */
export function isTrustedRequestOrigin(input: TrustedOriginInput): boolean {
  const publicHost = (input.trustProxy ? firstHeaderValue(input.forwardedHost) : undefined)
    ?? firstHeaderValue(input.host);
  if (!publicHost || !isAllowedHost(publicHost, input.allowedHosts ?? LOOPBACK_HOSTS)) {
    return false;
  }
  if (!input.origin) return true;

  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    return false;
  }

  if (origin.host.toLowerCase() !== publicHost.toLowerCase()) return false;
  const publicProtocol = normalizedProtocol(
    (input.trustProxy ? input.forwardedProto : undefined) ?? input.requestProtocol,
  );
  return !publicProtocol || origin.protocol === publicProtocol;
}

export function isTrustedCoveRequest(
  request: RequestLike,
  allowedHosts = getCoveAllowedHosts(),
): boolean {
  const trustProxy = coveEnv("TRUST_PROXY") === '1';
  return isTrustedRequestOrigin({
    origin: request.headers.get('origin'),
    host: request.headers.get('host') ?? request.nextUrl.host,
    forwardedHost: trustProxy ? request.headers.get('x-forwarded-host') : undefined,
    forwardedProto: trustProxy ? request.headers.get('x-forwarded-proto') : undefined,
    requestProtocol: request.nextUrl.protocol,
    allowedHosts,
    trustProxy,
  });
}

export function isLoopbackCoveRequest(request: RequestLike): boolean {
  return isTrustedCoveRequest(request, LOOPBACK_ACCESS_HOSTS);
}

/**
 * Hosts allowed to reach day-plan routes in loopback mode: the loopback aliases
 * plus any host named in COVE_TAILSCALE_TRUSTED_HOSTS.
 *
 * Naming a tailnet host here is only safe because the listener itself is bound
 * to 127.0.0.1, so the sole route in is a Tailscale Serve proxy that already
 * authenticated the device. The host check stays as DNS-rebinding defence: a
 * hostile page can point its own domain at this machine, but the Host header it
 * sends is its domain, never one on this list.
 */
export function dayPlanLoopbackHosts(
  environment: CoveHostEnvironment = process.env,
): string[] {
  const tailnet = (coveEnv('TAILSCALE_TRUSTED_HOSTS', environment) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...LOOPBACK_ACCESS_HOSTS, ...tailnet];
}

export function currentDayPlanAccessMode(): DayPlanAccessMode | undefined {
  const configured = coveEnv("DAY_PLAN_ACCESS_MODE")?.trim();
  if (!configured) return 'loopback';
  return configured === 'loopback' || configured === 'session' ? configured : undefined;
}

export function hasDayPlanRouteAccess(
  request: RequestLike,
  options: {
    accessMode?: DayPlanAccessMode;
    sessionToken?: string;
    loopbackHosts?: string[];
  } = {
    accessMode: currentDayPlanAccessMode(),
    sessionToken: coveEnv("DAY_PLAN_REMOTE_TOKEN"),
  },
): boolean {
  const accessMode = options.accessMode ?? currentDayPlanAccessMode();
  if (accessMode === 'loopback') {
    return isTrustedCoveRequest(request, options.loopbackHosts ?? dayPlanLoopbackHosts());
  }
  if (!isTrustedCoveRequest(request)) return false;
  if (accessMode !== 'session') return false;
  const supplied = request.headers.get('x-cove-day-plan-session');
  if (!options.sessionToken || !supplied) return false;
  const expectedBytes = Buffer.from(options.sessionToken);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}
