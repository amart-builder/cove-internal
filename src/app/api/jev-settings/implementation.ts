/**
 * The Jev settings screen's one route: read what every lane is doing, turn a
 * lane on or off, and store or remove the TypeSafe key.
 *
 * It is the same three writes `scripts/cove-jev.mjs` makes, reachable from the
 * running app so that turning a lane on does not mean opening a terminal. The
 * credential is the one addition: the CLI deliberately refuses to touch it,
 * because a key passed as an argument lands in shell history. A pasted form
 * field has no such trail, so this route accepts one, hands it to the store,
 * and never reads it back out: no response, error or log here carries the key,
 * and the screen only ever learns its last four characters.
 */
import { NextRequest, NextResponse } from "next/server";
import { localDatabasePath, openLocalDatabase } from "@/lib/local/database";
import { coveDataDir } from "@/lib/operator";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";
import {
  clearStoredJevCredential,
  jevCredentialStatus,
  saveJevCredential,
} from "@/lib/jev/credential";
import { readJevLastAttempts, readJevSpendSince, type JevLastAttempt } from "@/lib/jev/ledger";
import { readJevBreaker, type JevBreakerState } from "@/lib/jev/policy";
import type { JevSettingsState } from "@/lib/jev/presentation";
import {
  JEV_FEATURES,
  isJevFeature,
  readJevSettings,
  writeJevSettings,
  type JevFeature,
  type JevMode,
} from "@/lib/jev/settings";

export type JevSettingsPatch = {
  mode?: JevMode;
  features?: Partial<Record<JevFeature, boolean>>;
  /** A key to store, or null to remove the stored copy. */
  credential?: string | null;
};

/**
 * Parsed strictly, and the credential is checked for presence and type only:
 * its shape is the store's business, and repeating the rules here would mean a
 * second place that can reject a key for a reason the screen does not explain.
 */
export function parseJevSettingsPatch(value: unknown): JevSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cove could not read that change.");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set(["mode", "features", "credential"]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw new Error("Cove could not read that change.");
  }
  const patch: JevSettingsPatch = {};
  if (row.mode !== undefined) {
    if (row.mode !== "off" && row.mode !== "shadow") {
      // "assist" exists in the settings type for a promoted feature. Nothing is
      // promoted, so the screen may not be the thing that first grants it.
      throw new Error("Jev can be off or in shadow mode.");
    }
    patch.mode = row.mode;
  }
  if (row.features !== undefined) {
    if (!row.features || typeof row.features !== "object" || Array.isArray(row.features)) {
      throw new Error("Cove could not read that change.");
    }
    const features: Partial<Record<JevFeature, boolean>> = {};
    for (const [name, on] of Object.entries(row.features as Record<string, unknown>)) {
      if (!isJevFeature(name)) throw new Error(`Cove does not have a lane called ${name}.`);
      if (typeof on !== "boolean") throw new Error("A lane is either on or off.");
      features[name] = on;
    }
    if (Object.keys(features).length === 0) throw new Error("Name a lane to change.");
    patch.features = features;
  }
  if (row.credential !== undefined) {
    if (row.credential !== null && typeof row.credential !== "string") {
      throw new Error("Paste the TypeSafe key as text.");
    }
    patch.credential = row.credential;
  }
  if (Object.keys(patch).length === 0) throw new Error("Nothing to change.");
  return patch;
}

/**
 * Turning a lane on while Jev is off would leave the switch looking on and
 * nothing running, which is the exact failure the CLI's `enable` avoids by
 * naming shadow itself. The screen behaves the same way.
 */
export function modeAfterPatch(current: JevMode, patch: JevSettingsPatch): JevMode | undefined {
  if (patch.mode) return patch.mode;
  const turningOn = Object.values(patch.features ?? {}).some(Boolean);
  return turningOn && current === "off" ? "shadow" : undefined;
}

function readState(): JevSettingsState {
  const dataDir = coveDataDir();
  const settings = readJevSettings({ dataDir });
  const credential = jevCredentialStatus({ dataDir });
  const now = new Date();
  let last24h: JevSettingsState["last24h"];
  let breakers: Partial<Record<JevFeature, JevBreakerState>> = {};
  let attempts: Partial<Record<JevFeature, JevLastAttempt>> = {};
  // A fresh install has no ledger yet, and a lane that has never run is not a
  // failure worth refusing to draw the screen over.
  try {
    const db = openLocalDatabase(localDatabasePath());
    try {
      last24h = readJevSpendSince({
        since: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        db,
      });
      attempts = readJevLastAttempts({ db });
      breakers = Object.fromEntries(
        JEV_FEATURES.map((feature) => [feature, readJevBreaker({ db, feature, now })]),
      ) as Partial<Record<JevFeature, JevBreakerState>>;
    } finally {
      db.close();
    }
  } catch {
    last24h = undefined;
  }
  return {
    mode: settings.mode,
    model: settings.model,
    credential,
    lanes: JEV_FEATURES.map((feature) => ({
      feature,
      enabled: settings.features[feature],
      running: settings.mode !== "off" && settings.features[feature] && credential.configured,
      breaker: breakers[feature],
      lastAttempt: attempts[feature],
    })),
    limits: settings.limits,
    last24h,
    csrfToken: getQuietCurrentCsrfToken(),
  };
}

function denied(request: NextRequest, mutate = false) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (getRuntimeMode() !== "local") {
    return NextResponse.json({ error: "Available only in local Cove." }, { status: 404 });
  }
  if (mutate && request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Cove request token is missing." }, { status: 403 });
  }
}

export async function GET(request: NextRequest) {
  const refused = denied(request);
  if (refused) return refused;
  return NextResponse.json(readState());
}

export async function PATCH(request: NextRequest) {
  const refused = denied(request, true);
  if (refused) return refused;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4096) throw new Error("That change is too large.");
    const patch = parseJevSettingsPatch(JSON.parse(raw));
    const dataDir = coveDataDir();
    if (patch.credential !== undefined) {
      if (patch.credential === null) clearStoredJevCredential(dataDir);
      else saveJevCredential({ dataDir, credential: patch.credential });
    }
    if (patch.mode || patch.features) {
      const current = readJevSettings({ dataDir });
      writeJevSettings({
        dataDir,
        mode: modeAfterPatch(current.mode, patch),
        features: patch.features,
      });
    }
    return NextResponse.json(readState());
  } catch (error) {
    // Whatever went wrong, the message is this module's own or the store's.
    // Nothing here interpolates the submitted value.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cove could not save that change." },
      { status: 400 },
    );
  }
}
