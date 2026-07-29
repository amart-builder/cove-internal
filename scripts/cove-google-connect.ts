import { createServer } from "node:http";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createGoogleWorkspaceGateway,
  googleAuthorizationUrl,
  type WorkspaceConfig,
} from "../src/lib/workspace/google-connect";
import {
  deleteGoogleSecret,
  readGoogleSecret,
  writeGoogleSecret,
} from "../src/lib/workspace/google/keychain";
import { workspaceConfigPath } from "../src/lib/workspace/config";

const execFileAsync = promisify(execFile);

type ClientFile = {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
};

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestedTriageTimes(previous: unknown): string[] {
  const requested = flag("--triage-times");
  const values = requested
    ? requested.split(",").map((value) => value.trim())
    : Array.isArray(previous)
      ? previous.filter((value): value is string => typeof value === "string")
      : ["09:00", "15:00"];
  if (
    values.length === 0 ||
    values.length > 4 ||
    values.some((value) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
  ) {
    throw new Error("--triage-times must be one to four 24-hour times, separated by commas.");
  }
  return [...new Set(values)];
}

function clientFile(file: string): ClientFile {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const value = (parsed.installed ?? parsed.web) as Record<string, unknown> | undefined;
  if (
    !value ||
    typeof value.client_id !== "string" ||
    typeof value.client_secret !== "string"
  ) {
    throw new Error("Google OAuth client JSON must contain a desktop client.");
  }
  return {
    client_id: value.client_id,
    client_secret: value.client_secret,
    redirect_uris: Array.isArray(value.redirect_uris)
      ? value.redirect_uris.filter((item): item is string => typeof item === "string")
      : undefined,
  };
}

function writePrivateConfig(file: string, value: Record<string, unknown>): void {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

async function callback(): Promise<{
  redirectUri: string;
  wait: Promise<URL>;
  close: () => void;
}> {
  let resolveUrl!: (url: URL) => void;
  let rejectUrl!: (error: Error) => void;
  const wait = new Promise<URL>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Cove is connected. You can close this tab.");
      resolveUrl(url);
    } catch (error) {
      rejectUrl(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth callback did not bind.");
  return {
    redirectUri: `http://127.0.0.1:${address.port}`,
    wait,
    close: () => server.close(),
  };
}

async function connect(dataDir: string): Promise<void> {
  const clientPath = flag("--client-json");
  if (!clientPath) throw new Error("Usage: connect --client-json <downloaded Google OAuth JSON>");
  const client = clientFile(path.resolve(clientPath));
  const requestedProfileId = flag("--profile") ?? "primary";
  const profileId = `${requestedProfileId.slice(0, 56)}-${Date.now().toString(36)}`;
  const supportRecipient = flag("--support-recipient");
  const temporaryConfig: WorkspaceConfig = {
    version: 1,
    provider: "google-api",
    profileId,
    accountEmail: "pending@example.invalid",
    oauthClientId: client.client_id,
    capabilities: { mail: true, calendar: true, documents: true },
    calendarId: "primary",
    supportDraftRecipients: supportRecipient ? [supportRecipient.toLowerCase()] : [],
  };
  const pkce = (await import("../src/lib/workspace/google/auth")).createPkce();
  const receiver = await callback();
  try {
    const authorizationUrl = googleAuthorizationUrl({
      config: temporaryConfig,
      redirectUri: receiver.redirectUri,
      challenge: pkce.challenge,
      state: pkce.state,
    });
    await execFileAsync("/usr/bin/open", [authorizationUrl], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    process.stdout.write("Finish the Google consent screen in your browser.\n");
    const returned = await Promise.race([
      receiver.wait,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Google consent timed out.")), 180_000)
      ),
    ]);
    if (returned.searchParams.get("state") !== pkce.state) {
      throw new Error("Google OAuth state did not match.");
    }
    const code = returned.searchParams.get("code");
    if (!code) throw new Error(returned.searchParams.get("error") || "Google returned no code.");
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: receiver.redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const token = await tokenResponse.json() as Record<string, unknown>;
    if (!tokenResponse.ok || typeof token.refresh_token !== "string" || typeof token.access_token !== "string") {
      throw new Error("Google did not return a durable refresh token. Revoke Cove and reconnect.");
    }
    const profileResponse = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    const profile = await profileResponse.json() as Record<string, unknown>;
    if (!profileResponse.ok || typeof profile.emailAddress !== "string") {
      throw new Error("Cove could not verify the connected Gmail account.");
    }
    const configFile = workspaceConfigPath(dataDir);
    let previousProfileId: string | undefined;
    let previousConfig: Record<string, unknown> = {};
    if (existsSync(configFile)) {
      try {
        previousConfig = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
        if (typeof previousConfig.profile_id === "string") {
          previousProfileId = previousConfig.profile_id;
        }
      } catch {
        // A valid staged connection can replace a malformed old config.
      }
    }
    const expected = (
      flag("--account") ??
      (typeof previousConfig.account_email === "string"
        ? previousConfig.account_email
        : "")
    ).toLowerCase();
    const accountEmail = profile.emailAddress.toLowerCase();
    if (expected && expected !== accountEmail) {
      throw new Error(`Connected ${accountEmail}, but expected ${expected}.`);
    }
    const previousGmail = previousConfig.gmail &&
        typeof previousConfig.gmail === "object" &&
        !Array.isArray(previousConfig.gmail)
      ? previousConfig.gmail as Record<string, unknown>
      : {};
    const previousRecipients = Array.isArray(previousGmail.support_draft_recipients)
      ? previousGmail.support_draft_recipients.filter(
        (value): value is string => typeof value === "string",
      )
      : [];
    const supportDraftRecipients = supportRecipient
      ? [supportRecipient.toLowerCase()]
      : previousRecipients;
    let activated = false;
    try {
      await writeGoogleSecret(profileId, "client-secret", client.client_secret);
      await writeGoogleSecret(profileId, "refresh-token", token.refresh_token);
      const nextConfig: WorkspaceConfig = {
        version: 1,
        provider: "google-api",
        profileId,
        accountEmail,
        oauthClientId: client.client_id,
        capabilities: { mail: true, calendar: true, documents: true },
        calendarId: "primary",
        supportDraftRecipients,
      };
      await createGoogleWorkspaceGateway({ config: nextConfig }).mail.getProfile();
      const timezone = (
        flag("--timezone") ??
        (typeof previousConfig.timezone === "string" ? previousConfig.timezone : "") ??
        Intl.DateTimeFormat().resolvedOptions().timeZone
      ).trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const weekdaysFlag = flag("--weekdays-only");
      if (weekdaysFlag && weekdaysFlag !== "true" && weekdaysFlag !== "false") {
        throw new Error("--weekdays-only must be true or false.");
      }
      writePrivateConfig(configFile, {
        version: 1,
        provider: "google-api",
        profile_id: profileId,
        account_email: accountEmail,
        oauth_client_id: client.client_id,
        scope_set_version: 1,
        granted_scopes: typeof token.scope === "string" ? token.scope.split(" ") : [],
        capabilities: { mail: true, calendar: true, documents: true },
        calendar_id: "primary",
        triage_times: requestedTriageTimes(previousConfig.triage_times),
        timezone,
        weekdays_only: weekdaysFlag
          ? weekdaysFlag === "true"
          : previousConfig.weekdays_only === true,
        gmail: {
          support_draft_recipients: supportDraftRecipients,
        },
      });
      activated = true;
    } finally {
      if (!activated) {
        await Promise.all([
          deleteGoogleSecret(profileId, "client-secret"),
          deleteGoogleSecret(profileId, "refresh-token"),
        ]);
      }
    }
    if (previousProfileId && previousProfileId !== profileId) {
      await Promise.all([
        deleteGoogleSecret(previousProfileId, "client-secret"),
        deleteGoogleSecret(previousProfileId, "refresh-token"),
      ]);
    }
    process.stdout.write(`Connected Google Workspace for ${accountEmail}.\n`);
  } finally {
    receiver.close();
  }
}

async function status(dataDir: string): Promise<void> {
  const gateway = createGoogleWorkspaceGateway({ dataDir });
  const profile = await gateway.mail.getProfile();
  process.stdout.write(`Google Workspace is connected as ${profile.emailAddress}.\n`);
}

async function disconnect(dataDir: string): Promise<void> {
  const file = workspaceConfigPath(dataDir);
  if (!existsSync(file)) {
    process.stdout.write("Google Workspace is already disconnected.\n");
    return;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const profileId = typeof parsed.profile_id === "string" ? parsed.profile_id : "primary";
  try {
    const refreshToken = await readGoogleSecret(profileId, "refresh-token");
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
  } finally {
    await Promise.all([
      deleteGoogleSecret(profileId, "client-secret"),
      deleteGoogleSecret(profileId, "refresh-token"),
    ]);
    renameSync(file, `${file}.disconnected-${Date.now()}`);
  }
  process.stdout.write("Google Workspace was disconnected. The old config was preserved.\n");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = path.join(repoDir, "data");
  if (command === "connect" || command === "reauthorize") return connect(dataDir);
  if (command === "status") return status(dataDir);
  if (command === "disconnect") return disconnect(dataDir);
  throw new Error(
    "Usage: tsx scripts/cove-google-connect.ts connect --client-json <file> [--account email] [--triage-times 09:00,15:00] [--timezone Area/City] [--weekdays-only true|false] | status | disconnect",
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
