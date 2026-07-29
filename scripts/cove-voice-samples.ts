import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGoogleWorkspaceGateway } from "../src/lib/workspace/google/gateway";

function header(
  message: { headers: Array<{ name: string; value: string }> },
  name: string,
): string {
  return message.headers.find((item) => item.name.toLowerCase() === name.toLowerCase())
    ?.value ?? "";
}

function authoredText(text: string): string {
  return text
    .split(/\nOn .+ wrote:\s*\n/i, 1)[0]
    .split(/\nFrom:\s.+\nSent:\s/iu, 1)[0]
    .replace(/\n>.*$/gm, "")
    .trim()
    .slice(0, 8_000);
}

async function main(): Promise<void> {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const gateway = createGoogleWorkspaceGateway({ dataDir: path.join(repoDir, "data") });
  const page = await gateway.mail.listMessages({
    query: "in:sent newer_than:90d",
    maxResults: 60,
  });
  const samples = [];
  for (const listed of page.messages.slice(0, 60)) {
    const message = await gateway.mail.getMessage({
      messageId: listed.id,
      format: "full",
    });
    const text = authoredText(message.text);
    if (text.length < 40 || /^fwd:/i.test(header(message, "Subject"))) continue;
    samples.push({
      subject: header(message, "Subject").slice(0, 500),
      to: header(message, "To").slice(0, 500),
      text,
    });
    if (samples.length >= 30) break;
  }
  process.stdout.write(`${JSON.stringify({ samples }, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
