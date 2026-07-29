import { createHash, randomBytes } from "node:crypto";
import type { WorkspaceConfig } from "../config";
import { scopesForConfig } from "../config";
import { WorkspaceGatewayError } from "../errors";
import { readGoogleSecret } from "./keychain";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export function createPkce(): {
  verifier: string;
  challenge: string;
  state: string;
} {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}

export function googleAuthorizationUrl(input: {
  config: WorkspaceConfig;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: input.config.oauthClientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    scope: scopesForConfig(input.config).join(" "),
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
  }).toString();
  return url.toString();
}

type AccessToken = { value: string; expiresAt: number };

export class GoogleAccessTokenProvider {
  private cached?: AccessToken;

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly options: {
      fetch?: typeof fetch;
      now?: () => number;
      readSecret?: typeof readGoogleSecret;
    } = {},
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async getAccessToken(): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.value;
    }
    const readSecret = this.options.readSecret ?? readGoogleSecret;
    const [clientSecret, refreshToken] = await Promise.all([
      readSecret(this.config.profileId, "client-secret"),
      readSecret(this.config.profileId, "refresh-token"),
    ]);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.oauthClientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new WorkspaceGatewayError({
        code: "transient",
        operation: "oauth_refresh",
        safeMessage: "Google authentication was temporarily unavailable.",
        retryable: true,
        cause: error,
      });
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const authRequired = payload.error === "invalid_grant";
      throw new WorkspaceGatewayError({
        code: authRequired ? "auth_required" : "forbidden",
        operation: "oauth_refresh",
        safeMessage: authRequired
          ? "Google Workspace needs to be connected again."
          : "Google did not allow the requested Workspace access.",
        httpStatus: response.status,
      });
    }
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new WorkspaceGatewayError({
        code: "provider_contract",
        operation: "oauth_refresh",
        safeMessage: "Google returned an invalid access token response.",
      });
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3_600;
    this.cached = {
      value: payload.access_token,
      expiresAt: now + Math.max(60, expiresIn) * 1_000,
    };
    return this.cached.value;
  }
}
