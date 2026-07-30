import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { writeGoogleSecret } from "../src/lib/workspace/google/keychain.ts";

test("Keychain writes keep secrets out of argv and environment", async () => {
  const secret = "refresh-token-that-must-not-leak";
  let captured;
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    const stderr = new EventEmitter();
    stderr.setEncoding = () => {};
    child.stderr = stderr;
    child.stdin = {
      end(value) {
        captured = { command, args, options, stdin: value };
        queueMicrotask(() => child.emit("close", 0));
      },
    };
    return child;
  };
  await writeGoogleSecret("primary", "refresh-token", secret, { spawnProcess });
  assert.equal(captured.command, "/usr/bin/expect");
  assert.equal(captured.args.includes(secret), false);
  assert.equal(Object.values(captured.options.env).includes(secret), false);
  assert.equal(captured.stdin, `${secret}\n`);
  assert.equal(captured.args[0], "-c");
  assert.match(captured.args[1], /spawn \/usr\/bin\/security add-generic-password/);
  assert.match(captured.args[1], /primary:refresh-token/);
  assert.match(captured.args[1], /password data for new item/);
  assert.match(captured.args[1], /retype password for new item/);
});
