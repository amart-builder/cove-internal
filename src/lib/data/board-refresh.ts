export const BOARD_FETCH_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export async function retryBoardRequest<T>(
  request: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BOARD_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      const delay = BOARD_FETCH_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await wait(delay);
    }
  }
  throw lastError;
}
