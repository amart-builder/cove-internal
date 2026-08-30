import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { enqueueMeetingEnvelope } = require("../../src/lib/intake/meeting-analysis.ts");

const [dbPath, messageId, receivedAt] = process.argv.slice(2);
enqueueMeetingEnvelope({
  gmailMessageId: messageId,
  threadId: `thread-${messageId}`,
  tool: "granola",
  title: "Concurrent planning call",
  attendees: [{ name: "Pat External", email: "pat@example.com" }],
  body: "A sufficiently complete transcript. ".repeat(60),
  receivedAt,
  fragment: false,
}, { dbPath, now: new Date(receivedAt) });
