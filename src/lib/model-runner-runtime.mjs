import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { coveEnv } from "./env-runtime.mjs";
import { readAgentSettings, validateAgentSettings } from "./agent-settings.mjs";
import { reserveBackgroundAttempt, finishBackgroundAttempt, isPlanningLane } from "./background-usage.mjs";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export function configuredJobBackend(env = process.env, legacySetting) {
  const selected = readAgentSettings(env);
  if (selected) return selected.provider === "claude" ? "claude" : "codex-sol-high";
  return legacyJobBackend(env, legacySetting);
}

function legacyJobBackend(env, legacySetting) {
  const configured = coveEnv("JOB_RUNNER", env)?.trim().toLowerCase();
  if (configured) {
    if (configured === "codex-sol-high" || configured === "claude") return configured;
    throw new Error(`Unknown COVE_JOB_RUNNER value: ${configured}`);
  }
  if (legacySetting) {
    const legacy = coveEnv(legacySetting, env)?.trim().toLowerCase();
    if (legacy === "claude") return "claude";
    if (legacy === "codex" || legacy === "codex-sol-high") return "codex-sol-high";
    if (legacy) throw new Error(`Unknown legacy ${legacySetting} writer value: ${legacy}`);
  }
  return "codex-sol-high";
}

export function resolveCodexBinary(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const configured = coveEnv("CODEX_BIN", env)?.trim();
  if (configured) {
    return configured.includes(path.sep) && !exists(configured) ? undefined : configured;
  }
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "codex");
    if (exists(candidate)) return candidate;
  }
  for (const candidate of [
    path.join(options.home ?? homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
  ]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export function createCodexJobAttempt(input) {
  const executable = input.executable ?? resolveCodexBinary({ env: input.env });
  if (!executable || (executable.includes(path.sep) && !existsSync(executable))) return undefined;
  const cwd = mkdtempSync(path.join(tmpdir(), input.tempPrefix ?? "cove-model-job-"));
  chmodSync(cwd, 0o700);
  const outputPath = path.join(cwd, "last-message.txt");
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-m",
    input.selection?.model ?? "gpt-5.6-sol",
    "-c",
    `model_reasoning_effort=${input.selection?.effort ?? "high"}`,
    "--output-last-message",
    outputPath,
  ];
  if (input.selection) args.push("--json");
  if (input.webSearch) args.push("-c", "tools.web_search=true");
  args.push("-");
  return {
    command: { executable, cwd, args, stdin: input.prompt },
    outputPath,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

export function readCodexJobOutput(attempt) {
  if (statSync(attempt.outputPath).size > MAX_OUTPUT_BYTES) {
    throw new Error("model_output_too_large");
  }
  return readFileSync(attempt.outputPath, "utf8");
}

function minimalJobEnvironment(env) {
  const allowed = [
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL",
    "NODE_ENV", "XDG_CONFIG_HOME", "CODEX_HOME", "OPENAI_API_KEY",
    "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
  );
}

function signalGroup(child, signal) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may already be gone.
  }
}

function runCommand(command, options) {
  return new Promise((resolve) => {
    if (options.abortSignal?.aborted) {
      resolve({ ok: false, aborted: true, error: "job_aborted" });
      return;
    }
    let child;
    try {
      child = (options.spawnImpl ?? spawn)(command.executable, command.args, {
        cwd: command.cwd,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: minimalJobEnvironment(options.env),
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : "spawn_failed" });
      return;
    }
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let overflowed = false;
    let killTimer;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      try {
        options.onSettled?.();
      } catch {
        // The lane's durable state remains authoritative if cleanup bookkeeping fails.
      }
      resolve({ ...result, observedOutputBytes: stdoutBytes });
    };
    const terminate = () => {
      signalGroup(child, "SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(
        () => signalGroup(child, "SIGKILL"),
        options.terminationGraceMs ?? 2_000,
      );
      killTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref();
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      options.onSpawn?.(child, command);
    } catch (error) {
      signalGroup(child, "SIGTERM");
      finish({
        ok: false,
        error: error instanceof Error ? error.message : "spawn_registration_failed",
      });
      return;
    }
    child.stdout.on("data", (chunk) => {
      if (overflowed) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      const remaining = (options.maxOutputBytes ?? MAX_OUTPUT_BYTES) - stdoutBytes;
      if (options.diagnosticOutput) {
        stdoutBytes += bytes;
        stdout = `${stdout}${chunk}`;
        while (Buffer.byteLength(stdout, "utf8") > MAX_DIAGNOSTIC_BYTES) {
          stdout = stdout.slice(Math.max(1, Math.floor(stdout.length / 8)));
        }
        return;
      }
      if (bytes > remaining) {
        overflowed = true;
        stdoutBytes += bytes;
        terminate();
        return;
      }
      stdout += chunk;
      stdoutBytes += bytes;
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`;
      while (Buffer.byteLength(stderr, "utf8") > MAX_DIAGNOSTIC_BYTES) {
        stderr = stderr.slice(Math.max(1, Math.floor(stderr.length / 8)));
      }
    });
    child.once("error", (error) => finish({
      ok: false,
      timedOut,
      aborted,
      overflowed,
      error: error instanceof Error ? error.message : "spawn_failed",
    }));
    child.once("close", (code, signal) => finish({
      ok: code === 0 && !signal && !timedOut && !aborted && !overflowed,
      code,
      signal,
      timedOut,
      aborted,
      overflowed,
      stdout,
      stderr,
    }));
    child.stdin.once("error", () => signalGroup(child, "SIGTERM"));
    child.stdin.end(command.stdin);
  });
}

function validateSchema(value, schema, pathLabel = "$", errors = []) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return errors;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${pathLabel} is not an allowed value`);
  }
  if ("const" in schema && !Object.is(schema.const, value)) {
    errors.push(`${pathLabel} does not match the required constant`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) validateSchema(value, part, pathLabel, errors);
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((part) => validateSchema(value, part, pathLabel, []).length === 0)) {
    errors.push(`${pathLabel} does not match any allowed schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((part) => validateSchema(value, part, pathLabel, []).length === 0);
    if (matches.length !== 1) errors.push(`${pathLabel} must match exactly one schema`);
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0) {
    const actual = value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : Number.isInteger(value)
          ? "integer"
          : typeof value === "number"
            ? "number"
            : typeof value;
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
      errors.push(`${pathLabel} must be ${types.join(" or ")}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${pathLabel} is too short`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${pathLabel} is too long`);
    if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern).test(value))) errors.push(`${pathLabel} has an invalid format`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${pathLabel} is too small`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${pathLabel} is too large`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${pathLabel} has too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${pathLabel} has too many items`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${pathLabel}[${index}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value;
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push(`${pathLabel}.${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in object) validateSchema(object[key], child, `${pathLabel}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(object)) {
        if (!known.has(key)) errors.push(`${pathLabel}.${key} is not allowed`);
      }
    }
  }
  return errors;
}

function parseStructuredArtifact(raw, schema) {
  let value;
  try {
    const trimmed = raw.trim();
    const unfenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
    value = JSON.parse(unfenced);
  } catch {
    return { ok: false, reason: "The result was not valid JSON." };
  }
  const errors = validateSchema(value, schema);
  return errors.length > 0
    ? { ok: false, reason: errors.slice(0, 8).join("; ") }
    : { ok: true, value };
}

function failure(code, lane, message) {
  return { ok: false, error: { code, lane, message: String(message).slice(0, 1000) } };
}

function claudeCommand(input, env) {
  const executable = input.claudePath ?? coveEnv("CLAUDE_BIN", env) ?? path.join(homedir(), ".local", "bin", "claude");
  const args = [
    "-p", "--no-session-persistence", "--permission-mode", "plan",
    "--tools", input.claudeTools ?? "", "--strict-mcp-config", "--mcp-config",
    input.claudeMcpConfigPath ?? path.join(process.cwd(), "scripts", "cove-empty-mcp.json"),
    "--model", input.selection?.model ?? "claude-opus-5", "--effort", input.selection?.effort ?? "high",
    "--output-format", input.kind === "structured" || input.selection ? "json" : "text",
  ];
  if (input.claudeNoChrome) args.push("--no-chrome");
  if (input.claudeDisableSlashCommands) args.push("--disable-slash-commands");
  if (input.claudeSettingsPath) args.push("--settings", input.claudeSettingsPath);
  if (input.kind === "structured") args.push("--json-schema", JSON.stringify(input.schema));
  if (input.claudeMaxBudgetUsd) args.push("--max-budget-usd", input.claudeMaxBudgetUsd);
  return { executable, cwd: input.cwd ?? process.cwd(), args, stdin: input.prompt };
}

function unwrapClaudeStructured(raw) {
  try {
    const outer = JSON.parse(raw.trim());
    if (outer && typeof outer === "object" && "structured_output" in outer) {
      return JSON.stringify(outer.structured_output);
    }
    if (outer && typeof outer.result === "string") return outer.result;
  } catch {
    // The common validator below will return the typed invalid-output failure.
  }
  return raw;
}

export async function runJob(input) {
  const env = input.env ?? process.env;
  let backend;
  let selection;
  try {
    selection = Object.hasOwn(input, "agentSettings")
      ? input.agentSettings ? validateAgentSettings(input.agentSettings) : undefined
      : readAgentSettings(env);
    backend = selection ? (selection.provider === "claude" ? "claude" : "codex-sol-high") : input.backend ?? legacyJobBackend(env);
  } catch (error) {
    return failure("runner_failed", input.lane, error instanceof Error ? error.message : error);
  }
  if (input.kind === "structured" && (!input.schema || typeof input.schema !== "object")) {
    return failure("runner_failed", input.lane, "Structured jobs require a JSON Schema.");
  }
  const planning = isPlanningLane(input.lane);
  // Daily rituals and chief reviews own their reasoning deadlines. The short
  // monitoring timeout must not silently shorten those bounded operations.
  const ownsTimeout = planning || input.lane === "chief-of-staff";
  const timeoutMs = selection && !ownsTimeout ? Math.min(input.timeoutMs ?? 120_000, selection.backgroundLimits.timeoutMs) : input.timeoutMs ?? 120_000;
  const outputLimit = planning ? MAX_OUTPUT_BYTES : selection?.backgroundLimits.outputBytesPerCall;
  const basePrompt = input.kind === "structured" && backend === "codex-sol-high"
    ? `${input.prompt}\n\nJSON_SCHEMA=${JSON.stringify(input.schema)}\nReturn only a JSON value matching JSON_SCHEMA.`
    : input.prompt;
  let lastReason = "invalid output";
  for (let attemptNumber = 0; attemptNumber < (input.kind === "structured" ? 2 : 1); attemptNumber += 1) {
    const prompt = attemptNumber === 0
      ? basePrompt
      : `${basePrompt}\n\nCORRECTION: Your previous output failed validation: ${lastReason}. Return only a result that matches the supplied JSON Schema.`;
    let reservation;
    try {
      if (selection) reservation = reserveBackgroundAttempt({ env, settings: selection, lane: input.lane, inputBytes: Buffer.byteLength(prompt) + (backend === "claude" && input.kind === "structured" ? Buffer.byteLength(JSON.stringify(input.schema)) : 0) });
    } catch (error) {
      const code = error?.code === "background_input_limit" ? "runner_input_too_large"
        : error?.code === "background_usage_limit" ? "runner_budget_exceeded" : "runner_failed";
      const result = failure(code, input.lane, error instanceof Error ? error.message : error);
      if (error?.retryAt) result.error.retryAt = error.retryAt;
      return result;
    }
    let raw;
    let usage;
    let observedOutputBytes = null;
    let attemptStatus = "failed";
    try {
      if (backend === "codex-sol-high") {
        const attempt = createCodexJobAttempt({
          prompt,
          selection,
          executable: input.codexPath,
          env,
          webSearch: input.webSearch === true,
          tempPrefix: `cove-${String(input.lane).replace(/[^a-z0-9_-]/gi, "-")}-`,
        });
        if (!attempt) return failure("codex_unavailable", input.lane, "Codex executable is unavailable.");
        try {
          const result = await runCommand(attempt.command, {
            env,
            spawnImpl: input.spawnImpl,
            timeoutMs,
            maxOutputBytes: outputLimit,
            diagnosticOutput: planning,
            abortSignal: input.abortSignal,
            terminationGraceMs: input.terminationGraceMs,
            onSpawn: input.onSpawn,
            onSettled: input.onSettled,
          });
          observedOutputBytes = result.observedOutputBytes ?? null;
          usage = providerUsage(result.stdout, "codex");
          if (result.overflowed) {
            return failure("runner_output_too_large", input.lane, "Codex output exceeded the allowed byte limit.");
          }
          if (result.aborted) return failure("runner_interrupted", input.lane, "Codex job was interrupted.");
          if (result.timedOut) return failure("codex_timeout", input.lane, "Codex job timed out.");
          if (!result.ok) {
            return failure("runner_failed", input.lane, result.stderr || result.error || `Codex exited ${result.code}.`);
          }
          try {
            raw = readCodexJobOutput(attempt);
          } catch (error) {
            if (error instanceof Error && error.message === "model_output_too_large") {
              return failure("runner_output_too_large", input.lane, "Codex output exceeded the allowed byte limit.");
            }
            return failure("runner_failed", input.lane, error instanceof Error ? error.message : error);
          }
        } finally {
          attempt.cleanup();
        }
      } else {
        const result = await runCommand(claudeCommand({ ...input, prompt, selection }, env), {
          env,
          spawnImpl: input.spawnImpl,
          timeoutMs,
          maxOutputBytes: outputLimit,
          abortSignal: input.abortSignal,
          terminationGraceMs: input.terminationGraceMs,
          onSpawn: input.onSpawn,
          onSettled: input.onSettled,
        });
        observedOutputBytes = result.observedOutputBytes ?? null;
        usage = providerUsage(result.stdout, "claude");
        if (result.overflowed) {
          return failure("runner_output_too_large", input.lane, "Claude output exceeded the allowed byte limit.");
        }
        if (result.aborted) return failure("runner_interrupted", input.lane, "Claude job was interrupted.");
        if (result.timedOut) return failure("runner_timeout", input.lane, "Claude job timed out.");
        if (!result.ok) return failure("runner_failed", input.lane, result.stderr || result.error || `Claude exited ${result.code}.`);
        raw = input.kind === "structured" || selection ? unwrapClaudeStructured(result.stdout) : result.stdout;
      }
      if (outputLimit && Buffer.byteLength(raw) > outputLimit) {
        return failure("runner_output_too_large", input.lane, "The model response exceeded Cove's per-call output limit.");
      }
      if (input.kind === "text") {
        attemptStatus = "succeeded";
        return { ok: true, lane: input.lane, backend, text: raw };
      }
      const parsed = parseStructuredArtifact(raw, input.schema);
      if (parsed.ok) {
        try {
          const value = input.validate
            ? await input.validate(raw, parsed.value)
            : parsed.value;
          attemptStatus = "succeeded";
          return { ok: true, lane: input.lane, backend, text: raw, value };
        } catch (error) {
          lastReason = error instanceof Error ? error.message : String(error);
          continue;
        }
      }
      lastReason = parsed.reason;
    } finally {
      if (reservation) finishBackgroundAttempt({ env, id: reservation, status: attemptStatus, outputBytes: raw === undefined ? observedOutputBytes : Buffer.byteLength(raw), usage });
    }
  }
  return failure(
    backend === "codex-sol-high" ? "codex_invalid_output" : "runner_failed",
    input.lane,
    lastReason,
  );
}


function providerUsage(raw, provider) {
  if (!raw) return undefined;
  for (const line of raw.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line);
      const usage = value.usage;
      if (!usage || (provider === "codex" && value.type !== "turn.completed")) continue;
      return {
        inputTokens: usage.input_tokens,
        cachedInputTokens: provider === "codex" ? usage.cached_input_tokens : usage.cache_read_input_tokens,
        outputTokens: usage.output_tokens,
      };
    } catch { /* CLI progress text is not usage evidence. */ }
  }
  return undefined;
}
