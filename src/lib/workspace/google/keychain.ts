import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceGatewayError } from "../errors";

const execFileAsync = promisify(execFile);
const SECURITY_BIN = "/usr/bin/security";
const EXPECT_BIN = "/usr/bin/expect";
const SERVICE = "com.cove.google";

type SecretChild = {
  stdin: { end(value: string): void } | null;
  stderr: {
    setEncoding(encoding: BufferEncoding): void;
    on(event: "data", listener: (chunk: string) => void): void;
  } | null;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnSecretProcess = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "ignore", "pipe"];
  },
) => SecretChild;

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME,
  };
}

export type SecretKind = "client-secret" | "refresh-token";

function account(profileId: string, kind: SecretKind): string {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(profileId)) {
    throw new WorkspaceGatewayError({
      code: "invalid_input",
      operation: "keychain",
      safeMessage: "Google Workspace profile id is invalid.",
    });
  }
  return `${profileId}:${kind}`;
}

export async function readGoogleSecret(
  profileId: string,
  kind: SecretKind,
  options: { exec?: typeof execFileAsync } = {},
): Promise<string> {
  try {
    const result = await (options.exec ?? execFileAsync)(
      SECURITY_BIN,
      ["find-generic-password", "-s", SERVICE, "-a", account(profileId, kind), "-w"],
      {
        env: minimalEnv(),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    );
    const value = result.stdout.trim();
    if (!value) throw new Error("empty secret");
    return value;
  } catch (error) {
    throw new WorkspaceGatewayError({
      code: "auth_required",
      operation: "keychain_read",
      safeMessage: "Google Workspace needs to be connected again.",
      cause: error,
    });
  }
}

export async function writeGoogleSecret(
  profileId: string,
  kind: SecretKind,
  value: string,
  options: {
    spawnProcess?: SpawnSecretProcess;
  } = {},
): Promise<void> {
  if (!value || value.length > 16_000) {
    throw new WorkspaceGatewayError({
      code: "invalid_input",
      operation: "keychain_write",
      safeMessage: "Google credential value is invalid.",
    });
  }
  const spawnProcess = options.spawnProcess ?? spawn as unknown as SpawnSecretProcess;
  const accountName = account(profileId, kind);
  // `security add-generic-password -w` prompts twice when no password is put
  // on argv. A plain pipe is not a terminal, so security accepts an empty
  // value instead of reading the piped secret. Expect supplies the required
  // pseudo-terminal while the credential still travels only over stdin.
  const expectScript = [
    "set timeout 15",
    "gets stdin secret",
    "log_user 0",
    `spawn ${SECURITY_BIN} add-generic-password -U -s ${SERVICE} -a ${accountName} -w`,
    'expect "password data for new item: "',
    'send -- "$secret\\r"',
    'expect "retype password for new item: "',
    'send -- "$secret\\r"',
    "expect eof",
    "set result [wait]",
    "exit [lindex $result 3]",
  ].join("; ");
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(
      EXPECT_BIN,
      ["-c", expectScript],
      {
        env: minimalEnv(),
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `security exited ${code}`));
    });
    child.stdin?.end(`${value}\n`);
  }).catch((error) => {
    throw new WorkspaceGatewayError({
      code: "auth_required",
      operation: "keychain_write",
      safeMessage: "Google credential could not be saved in Keychain.",
      cause: error,
    });
  });
}

export async function deleteGoogleSecret(
  profileId: string,
  kind: SecretKind,
  options: { exec?: typeof execFileAsync } = {},
): Promise<void> {
  try {
    await (options.exec ?? execFileAsync)(
      SECURITY_BIN,
      ["delete-generic-password", "-s", SERVICE, "-a", account(profileId, kind)],
      {
        env: minimalEnv(),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    );
  } catch {
    // Disconnect is idempotent. A missing item is already disconnected.
  }
}
