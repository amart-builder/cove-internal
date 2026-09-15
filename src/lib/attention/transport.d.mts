export type AttentionTransport = {
  banner(message: string, subtitle?: string, openUrl?: string): void;
  text(message: string): boolean;
  textConfigured: boolean;
};

export function attentionReminderConfigPath(input?: {dataDir?: string; repoDir?: string; env?: NodeJS.ProcessEnv}): string;

export function createAttentionTransport(input?: {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  repoDir?: string;
  execFileSyncImpl?: (
    executable: string,
    args?: readonly string[],
    options?: { timeout?: number },
  ) => Buffer | string;
  config?: Record<string, unknown> | null;
  telegramToken?: string | null;
}): AttentionTransport;
