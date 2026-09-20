/**
 * Where the TypeSafe key lives on this machine, and how a lane finds it.
 *
 * The key started out as an environment variable and stays one: a machine that
 * already has `COVE_TYPESAFE_API_KEY` in `.env.local` keeps working exactly as
 * it did, and the environment always wins. What this module adds is a second
 * place to put it, owned by Cove rather than by whoever edits `.env.local`, so
 * the key can be pasted into the settings screen on a running install instead
 * of into a file that is only read when the server starts.
 *
 * The stored copy is a file in the operator's data directory, written 0600 and
 * never anywhere near the repository. It is read on demand, never cached, and
 * never returned by anything that reports status: the readers here hand back
 * presence, a source, and the last four characters, which is enough to tell one
 * key from another and not enough to use.
 */
import { readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { coveConfigPath, coveConfigWritePath, type CoveEnvironment } from "../env";
import { readJevCredential } from "./settings";

/** Where the key came from, so the screen can say so and stay honest. */
export type JevCredentialSource = "environment" | "stored" | "none";

export type JevCredentialStatus = {
  configured: boolean;
  source: JevCredentialSource;
  /** Last four characters only. Never the key. */
  hint?: string;
  /** When the stored copy was written. Absent for an environment key. */
  savedAt?: string;
};

const CREDENTIAL_FILE = "jev-credential.json";
const MIN_LENGTH = 20;
const MAX_LENGTH = 400;

export function jevCredentialPath(dataDir: string): string {
  return coveConfigPath(dataDir, CREDENTIAL_FILE);
}

/**
 * A key is one run of printable, non-space characters. Rejecting whitespace is
 * not fussiness: a key pasted with a trailing newline or a stray quote fails at
 * TypeSafe as a 401, which the breaker then treats as a wrong key and sits on
 * for an hour. Better to refuse it here, where there is someone to tell.
 */
export function normaliseJevCredential(value: unknown): string {
  if (typeof value !== "string") throw new Error("Paste the TypeSafe key as text.");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Paste the TypeSafe key first.");
  if (trimmed.length < MIN_LENGTH || trimmed.length > MAX_LENGTH) {
    throw new Error("That does not look like a TypeSafe key.");
  }
  if (!/^[\x21-\x7e]+$/.test(trimmed)) {
    throw new Error("The key has spaces or unusual characters in it. Paste it again.");
  }
  return trimmed;
}

export function jevCredentialHint(credential: string): string {
  return credential.slice(-4);
}

type StoredCredential = { credential: string; savedAt?: string };

export function readStoredJevCredential(dataDir: string): StoredCredential | undefined {
  let raw: string;
  try {
    raw = readFileSync(jevCredentialPath(dataDir), "utf8");
  } catch {
    // Not having configured Jev is the normal state of a Cove install.
    return undefined;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    const credential = typeof row.credential === "string" ? row.credential.trim() : "";
    if (!credential) return undefined;
    return {
      credential,
      savedAt: typeof row.savedAt === "string" ? row.savedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Written to a temporary file and renamed, so a half-written key is never left
 * where a lane could read it, and created 0600 rather than chmodded afterwards,
 * so it is never briefly world-readable.
 */
export function saveJevCredential(input: {
  dataDir: string;
  credential: string;
  now?: Date;
}): JevCredentialStatus {
  const credential = normaliseJevCredential(input.credential);
  const file = coveConfigWritePath(input.dataDir, CREDENTIAL_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  const savedAt = (input.now ?? new Date()).toISOString();
  rmSync(temporary, { force: true });
  writeFileSync(
    temporary,
    `${JSON.stringify({ credential, savedAt }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  renameSync(temporary, file);
  return { configured: true, source: "stored", hint: jevCredentialHint(credential), savedAt };
}

/** Removing the stored copy never touches an environment key. */
export function clearStoredJevCredential(dataDir: string): boolean {
  try {
    unlinkSync(jevCredentialPath(dataDir));
    return true;
  } catch {
    return false;
  }
}

/** The key itself, environment first. Callers pass it on; nothing logs it. */
export function resolveJevCredential(input: {
  dataDir: string;
  env?: CoveEnvironment;
}): string | undefined {
  const fromEnvironment = readJevCredential(input.env ?? process.env);
  if (fromEnvironment) return fromEnvironment;
  return readStoredJevCredential(input.dataDir)?.credential;
}

export function jevCredentialStatus(input: {
  dataDir: string;
  env?: CoveEnvironment;
}): JevCredentialStatus {
  const fromEnvironment = readJevCredential(input.env ?? process.env);
  if (fromEnvironment) {
    return {
      configured: true,
      source: "environment",
      hint: jevCredentialHint(fromEnvironment),
    };
  }
  const stored = readStoredJevCredential(input.dataDir);
  if (!stored) return { configured: false, source: "none" };
  return {
    configured: true,
    source: "stored",
    hint: jevCredentialHint(stored.credential),
    savedAt: stored.savedAt,
  };
}

/**
 * The seam that lets a stored key reach code that only knows about the
 * environment.
 *
 * Everything downstream of a lane's entry point — the feature gate, the request
 * builder, the client — reads the credential out of an environment bag. Rather
 * than thread a second argument through all of it, the entry point hands that
 * code an environment with the stored key added. The copy is local to one call;
 * `process.env` is never mutated, so the key does not leak into a child process
 * Cove spawns for some unrelated reason.
 */
export function withJevCredential(
  env: CoveEnvironment,
  dataDir: string,
): CoveEnvironment {
  if (readJevCredential(env)) return env;
  const stored = readStoredJevCredential(dataDir);
  if (!stored) return env;
  return { ...env, COVE_TYPESAFE_API_KEY: stored.credential };
}
