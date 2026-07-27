#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  decideArrivalDelivery,
  parseArrivalConfig,
} from "./lib/forge-arrival-schedule.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(repoDir, "data");
const receiptPath = path.join(dataDir, "forge-arrival-receipts.json");
const lockPath = path.join(dataDir, "forge-arrival-spike.lock");
const defaultConfigPath = path.join(dataDir, "forge-arrival.json");
const MAX_RECEIPT_BYTES = 1024 * 1024;
const LOCK_STALE_MS = 5 * 60 * 1000;

function log(result, eventKey) {
  const entry = { timestamp: new Date().toISOString() };
  if (eventKey) entry.eventKey = eventKey;
  entry.result = result;
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

async function loadConfig() {
  const override = process.env.FORGE_ARRIVAL_CONFIG?.trim();
  if (override?.startsWith("{")) return parseArrivalConfig(override);
  const configPath = override ? path.resolve(override) : defaultConfigPath;
  return parseArrivalConfig(await readFile(configPath, "utf8"));
}

async function writeExclusiveLock() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, at: Date.now() }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const lock = JSON.parse(await readFile(lockPath, "utf8"));
          if (lock.token === token) await unlink(lockPath);
        } catch {
          // A missing or replaced lock does not belong to this process.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const lockStat = await stat(lockPath);
        stale = Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
        if (!stale) {
          let lock;
          try {
            lock = JSON.parse(await readFile(lockPath, "utf8"));
          } catch {
            // The owner may still be between its exclusive create and write.
            return undefined;
          }
          if (Number.isInteger(lock.pid)) {
            try {
              process.kill(lock.pid, 0);
            } catch (processError) {
              stale = processError?.code === "ESRCH";
            }
          }
        }
      } catch {
        stale = true;
      }
      if (!stale || attempt === 1) return undefined;
      try {
        await unlink(lockPath);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function readReceipts() {
  let text;
  try {
    text = await readFile(receiptPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, deliveries: [] };
    throw error;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) {
    throw new Error("Receipt file is too large.");
  }
  const value = JSON.parse(text);
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.deliveries) ||
    value.deliveries.some(
      (item) =>
        !item ||
        typeof item.key !== "string" ||
        typeof item.localDate !== "string" ||
        typeof item.deliveredAt !== "string",
    )
  ) {
    throw new Error("Receipt file has an invalid shape.");
  }
  return value;
}

async function appendReceipt(receipts, decision) {
  const deliveries = receipts.deliveries.filter((item) => item.key !== decision.eventKey);
  deliveries.push({
    key: decision.eventKey,
    localDate: decision.localDate,
    deliveredAt: new Date().toISOString(),
  });
  const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, deliveries }, null, 2)}\n`);
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, receiptPath);
    await chmod(receiptPath, 0o600);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the original atomic-write failure.
    }
    throw error;
  }
}

async function fetchReadModel(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Forge did not return a successful day plan response.");
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !["--live-open", "--check-config"].includes(arg))) {
    log("invalid_arguments");
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = await loadConfig();
  } catch {
    log("config_invalid");
    process.exitCode = 2;
    return;
  }
  if (args.has("--check-config")) {
    log("config_valid");
    return;
  }

  const releaseLock = await writeExclusiveLock();
  if (!releaseLock) {
    log("lock_busy");
    return;
  }

  try {
    let readModel;
    try {
      readModel = await fetchReadModel(config.day_plan_url);
    } catch {
      log("server_unavailable");
      process.exitCode = 1;
      return;
    }

    let receipts;
    try {
      receipts = await readReceipts();
    } catch {
      log("receipt_invalid");
      process.exitCode = 1;
      return;
    }
    const decision = decideArrivalDelivery({
      now: new Date(),
      config,
      readModel,
      receiptKeys: new Set(receipts.deliveries.map((item) => item.key)),
    });
    if (!decision.shouldOpen) {
      log(decision.result);
      return;
    }
    if (!args.has("--live-open")) {
      log("dry_run", decision.eventKey);
      return;
    }

    try {
      execFileSync("/usr/bin/open", [config.tasks_url], { stdio: "ignore" });
    } catch {
      log("open_failed", decision.eventKey);
      process.exitCode = 1;
      return;
    }
    try {
      await appendReceipt(receipts, decision);
    } catch {
      log("receipt_write_failed", decision.eventKey);
      process.exitCode = 1;
      return;
    }
    log("opened", decision.eventKey);
  } finally {
    await releaseLock();
  }
}

try {
  await main();
} catch {
  // launchd captures stderr too, so never let Node print a stack that could
  // include config contents, URLs, or unrelated environment details.
  log("internal_error");
  process.exitCode = 1;
}
