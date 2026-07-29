export type WorkspaceErrorCode =
  | "not_configured"
  | "auth_required"
  | "insufficient_scope"
  | "admin_policy"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "transient"
  | "invalid_input"
  | "unsafe_operation"
  | "provider_contract"
  | "unknown_write_outcome";

export class WorkspaceGatewayError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly operation: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly providerRequestId?: string;

  constructor(input: {
    code: WorkspaceErrorCode;
    operation: string;
    safeMessage: string;
    retryable?: boolean;
    httpStatus?: number;
    retryAfterMs?: number;
    providerRequestId?: string;
    cause?: unknown;
  }) {
    super(input.safeMessage, { cause: input.cause });
    this.name = "WorkspaceGatewayError";
    this.code = input.code;
    this.operation = input.operation;
    this.retryable = input.retryable ?? false;
    this.httpStatus = input.httpStatus;
    this.retryAfterMs = input.retryAfterMs;
    this.providerRequestId = input.providerRequestId;
  }
}

export function safeWorkspaceFailure(error: unknown): {
  code: WorkspaceErrorCode;
  operation: string;
  retryable: boolean;
  message: string;
} {
  if (error instanceof WorkspaceGatewayError) {
    return {
      code: error.code,
      operation: error.operation,
      retryable: error.retryable,
      message: error.message,
    };
  }
  return {
    code: "transient",
    operation: "unknown",
    retryable: true,
    message: "Google Workspace was temporarily unavailable.",
  };
}
