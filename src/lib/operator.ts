import * as runtime from "./operator-runtime.mjs";

export type OperatorProfile = Record<string, unknown>;

export function coveDataDir(explicit?: string): string {
  return runtime.coveDataDir(explicit);
}

export function operatorProfilePath(dataDir?: string): string {
  return runtime.operatorProfilePath(dataDir);
}

export function loadOperatorProfile(): OperatorProfile | undefined {
  return runtime.loadOperatorProfile() as OperatorProfile | undefined;
}

export function operatorName(): string {
  return runtime.operatorName();
}

export function operatorTimezone(): string {
  return runtime.operatorTimezone();
}

export function workspaceRoot(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  exists?: (candidate: string) => boolean;
} = {}): string | null {
  return runtime.workspaceRoot(options);
}
