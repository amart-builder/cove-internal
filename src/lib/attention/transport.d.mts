export type AttentionTransport = {
  banner(message: string, subtitle?: string, openUrl?: string): void;
  text(message: string): boolean;
  textConfigured: boolean;
};

export function createAttentionTransport(input?: {
  repoDir?: string;
  execFileSyncImpl?: (
    executable: string,
    args?: readonly string[],
    options?: { timeout?: number },
  ) => Buffer | string;
  config?: Record<string, unknown> | null;
  telegramToken?: string | null;
}): AttentionTransport;
