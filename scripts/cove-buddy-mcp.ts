import { createBuddyMcpHandler, MCP_MAX_LINE_BYTES } from "../src/lib/buddy/mcp";

async function main() {
  const handle = createBuddyMcpHandler();
  // Never let an isolated/test caller fall back to the operator's live server.
  if (!process.env.COVE_BUDDY_APP_URL) throw new Error("COVE_BUDDY_APP_URL is required for the Buddy tool connection");
  let buffer = Buffer.alloc(0);
  // Sequential reads bound the queue and preserve command order. Stdout is MCP only.
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let newline: number;
    while ((newline = buffer.indexOf(10)) >= 0) {
      if (newline > MCP_MAX_LINE_BYTES) throw new Error("MCP request too large");
      const line = buffer.subarray(0, newline).toString("utf8").trim();
      buffer = buffer.subarray(newline + 1);
      if (!line) continue;
      let request: unknown;
      try { request = JSON.parse(line); } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      const response = await handle(request);
      if (response !== undefined) {
        await new Promise<void>((resolve, reject) => {
          process.stdout.write(JSON.stringify(response) + "\n", error => error ? reject(error) : resolve());
        });
      }
    }
    if (buffer.length > MCP_MAX_LINE_BYTES) throw new Error("MCP request too large");
  }
}

void main().catch(() => {
  process.stderr.write("Cove Buddy tool connection stopped: invalid configuration or transport failure.\n");
  process.exitCode = 1;
});
