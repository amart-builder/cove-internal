import * as runtime from "./operator-runtime.mjs";

export type OperatorProfile = Record<string, unknown>;

export function coveDataDir(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return runtime.coveDataDir(explicit, env);
}

export function operatorProfilePath(
  dataDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return runtime.operatorProfilePath(dataDir, env);
}

export function loadOperatorProfile(
  dataDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): OperatorProfile | undefined {
  return runtime.loadOperatorProfile(dataDir, env) as OperatorProfile | undefined;
}

export function operatorName(
  dataDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return runtime.operatorName(dataDir, env);
}

export function operatorDefaultProject(
  dataDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return runtime.operatorDefaultProject(dataDir, env);
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
