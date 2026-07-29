#!/usr/bin/env node
import { extractEmailAttachments } from "./lib/email-attachments.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const parsed = JSON.parse(input || "[]");
const attachments = Array.isArray(parsed) ? parsed : parsed.attachments;
process.stdout.write(`${JSON.stringify(extractEmailAttachments(attachments))}\n`);
