// Every Codex job on the Mac goes through codexPasswordManagerOverrides, and it
// used to accept exactly one English sentence as "no such server". A Codex that
// worded it any other way stopped the brief, intake, the wake and the rest --
// and the refusal was thrown, so the screen said only that some background work
// did not finish.
import test from "node:test";
import assert from "node:assert/strict";
import { codexPasswordManagerOverrides } from "../src/lib/model-runner-runtime.mjs";
import { diagnosticCause, jobFailureDetail } from "../src/lib/reliability/job-failure-copy.ts";

const DISABLE = ["-c", "mcp_servers.1password.enabled=false"];

function guard(probe) {
  return codexPasswordManagerOverrides({ executable: "codex", probe });
}

test("absence is recognised however this Codex words it", () => {
  for (const stderr of [
    "Error: No MCP server named '1password' found.\n",
    "error: no MCP server named \"1password\" found\n",
    "Error: server `1password` not found\n",
    "no such MCP server: 1password\n",
    "Error: unknown server '1password'\n",
    "Error: MCP server 1password does not exist.\n",
    "WARNING: PATH aliases unavailable\nError: No MCP server named '1password' found.\n",
  ]) {
    assert.deepEqual(guard(() => ({ status: 1, stderr })), [], stderr.trim());
  }
});

test("a configured connector is disabled, in any shape the CLI reports it", () => {
  for (const stdout of [
    JSON.stringify({ name: "1password" }),
    JSON.stringify({ server: { name: "1password", command: "op" } }),
    JSON.stringify({ mcp_servers: { "1password": { command: "op" } } }),
    JSON.stringify({ mcpServers: { "1password": {} } }),
    JSON.stringify({ servers: [{ name: "other" }, { name: "1password" }] }),
    JSON.stringify({ servers: ["1password"] }),
  ]) {
    assert.deepEqual(guard(() => ({ status: 0, stdout })), DISABLE, stdout);
  }
});

test("a Codex without the subcommand is asked the other way instead of refused", () => {
  const calls = [];
  const absent = guard((_executable, args) => {
    calls.push(args.join(" "));
    return args[1] === "get"
      ? { status: 2, stderr: "error: unrecognized subcommand 'get'\n" }
      : { status: 0, stdout: JSON.stringify({ mcp_servers: { github: {} } }) };
  });
  assert.deepEqual(absent, []);
  assert.deepEqual(calls, ["mcp get 1password --json", "mcp list --json"]);

  const present = guard((_executable, args) => (args[1] === "get"
    ? { status: 2, stderr: "usage: codex mcp <command>\n" }
    : { status: 0, stdout: JSON.stringify({ mcp_servers: { "1password": {} } }) }));
  assert.deepEqual(present, DISABLE);
});

test("it still fails closed on anything that is not an answer", () => {
  // A background agent that can reach the operator's password manager is worse
  // than a job that does not run, so none of these may be read as "absent".
  for (const result of [
    { status: 1, stderr: "invalid config private-value" },
    { status: null, error: new Error("timed out"), stderr: "Error: No MCP server named '1password' found.\n" },
    { status: 0, stdout: "private-value" },
    { status: 0, stdout: JSON.stringify({ name: "other" }) },
    { status: 1, stderr: "Error: not logged in. Run `codex login`.\n" },
    { status: 1, stderr: "" },
  ]) {
    assert.throws(() => guard(() => result), /could not verify/, JSON.stringify(result.stderr ?? result.stdout));
  }

  // And a fallback that cannot answer either does not become an answer.
  assert.throws(
    () => guard((_executable, args) => (args[1] === "get"
      ? { status: 2, stderr: "error: unrecognized subcommand 'get'\n" }
      : { status: 1, stderr: "error: unrecognized subcommand 'list'\n" })),
    /could not verify/,
  );
});

test("the refusal reaches the screen with a cause and something to do", () => {
  const detail = jobFailureDetail("morning-brief", "Codex password-manager check did not answer.");
  assert.match(detail, /password-manager connector is switched off/);
  assert.match(detail, /ask your Cove setup agent to check Codex's connector settings/);
  assert.doesNotMatch(detail, /try again automatically/);

  // The old wording named nothing, which is what the person saw.
  const { cause } = diagnosticCause("Codex exited 1.");
  assert.equal(cause, "");
});
