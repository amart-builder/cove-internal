/** Narrow stdio MCP adapter. All authorization and writes stay in the data CLI. */
import { main as runDataCommand } from "../../../scripts/cove-buddy-data";

export const BUDDY_MCP_SERVER = "cove_buddy";
export const BUDDY_MCP_TOOL = "cove_data";
export const MCP_MAX_LINE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TOOL = {
  name: BUDDY_MCP_TOOL,
  description: "Access Cove tasks, calendar, live email, documents, contacts and history, goals, brief, closeouts, chief context, reminders, and follow-through using validated commands. Run args:[\"help\"] for syntax. Supply CLI arguments as separate strings without a shell prefix. Permanent deletion requires the existing user confirmation token. Start a new task session only when explicitly requested.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["args"],
    properties: { args: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", maxLength: 16000 } } },
  },
};

export function createBuddyMcpHandler(run = runDataCommand) {
  let initialized = false;
  return async (value: unknown): Promise<unknown | undefined> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    const request = value as Record<string, unknown>;
    const hasId = Object.hasOwn(request, "id");
    const id = typeof request.id === "string" || typeof request.id === "number" ? request.id : null;
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    const result = (payload: unknown) => ({ jsonrpc: "2.0", id, result: payload });
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || (hasId && id === null)) {
      return error(-32600, "Invalid request");
    }
    // Notifications can never invoke commands, even if shaped like tools/call.
    if (!hasId) return undefined;
    if (request.method === "initialize") {
      initialized = true;
      return result({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: BUDDY_MCP_SERVER, version: "1.0.0" } });
    }
    if (request.method === "ping") return result({});
    if (!initialized) return error(-32000, "Initialize before using Cove tools");
    if (request.method === "tools/list") return result({ tools: [TOOL] });
    if (request.method !== "tools/call") return error(-32601, "Method not found");
    const params = request.params as { name?: unknown; arguments?: Record<string, unknown> } | undefined;
    const args = params?.arguments?.args;
    if (params?.name !== BUDDY_MCP_TOOL || !params.arguments ||
        Object.keys(params.arguments).some(key => key !== "args") ||
        !Array.isArray(args) || args.length < 1 || args.length > 64 ||
        args.some(arg => typeof arg !== "string" || arg.length > 16000 || arg.includes("\0")) ||
        Buffer.byteLength(JSON.stringify(args)) > MCP_MAX_LINE_BYTES / 2) {
      return error(-32602, "Expected cove_data with a bounded array of string arguments");
    }
    const output: string[] = [];
    let bytes = 0;
    const write = (line: string) => {
      const nextBytes = bytes + Buffer.byteLength(line) + 1;
      if (nextBytes > MAX_OUTPUT_BYTES) {
        const error = new Error("output_limit: Cove's result exceeded 1 MB. Narrow --limit, select columns with --select, or use email/contacts/read commands with --offset and --max-chars. Earlier mutation receipts remain valid; check current state before retrying a write.");
        error.name = "CoveOutputLimitError";
        throw error;
      }
      bytes = nextBytes;
      output.push(line);
    };
    try {
      const code = await run(args, { write, writeError: write });
      return result({ isError: code !== 0, content: [{ type: "text", text: output.join("\n") }] });
    } catch (error) {
      // Preserve any already-confirmed receipts if a later operation fails.
      const message = error instanceof Error && error.name === "CoveOutputLimitError" ? error.message
        : "tool_execution_failed: Cove's tool stopped unexpectedly. This is not an output-limit diagnosis. Earlier receipts remain valid; check current state before retrying a write.";
      return result({ isError: true, content: [{ type: "text", text: [...output, `ERROR ${message}`].join("\n") }] });
    }
  };
}
