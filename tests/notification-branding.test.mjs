import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  COVE_NOTIFICATION_ICON_RELATIVE_PATH,
  nativeNotificationCommand,
} from "../src/lib/intake/notification-transport.mjs";

const ROOT = process.cwd();
const ICON_PATH = path.join(ROOT, COVE_NOTIFICATION_ICON_RELATIVE_PATH);

test("the Cove notification asset is a square RGBA PNG suitable for macOS", () => {
  const png = readFileSync(ICON_PATH);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
});

test("branded notifications keep copy in argv and attach the Cove icon", () => {
  const notificationApp = "/Users/test/Applications/Cove Notifications.app/Contents/MacOS/CoveNotifier";
  const command = nativeNotificationCommand("Review the proposal", {
    title: "Cove",
    subtitle: "Task due",
    sound: "Glass",
    group: "cove-task-1",
    openUrl: "http://127.0.0.1:3200/tasks",
  }, {
    notificationAppPath: notificationApp,
    exists: (candidate) => candidate === notificationApp,
  });
  assert.equal(command.executable, notificationApp);
  assert.deepEqual(command.args, [
    "--title", "Cove",
    "--message", "Review the proposal",
    "--subtitle", "Task due",
    "--sound", "Glass",
    "--group", "cove-task-1",
    "--open-url", "http://127.0.0.1:3200/tasks",
  ]);
});

test("native notifications retain the AppleScript fallback", () => {
  const command = nativeNotificationCommand("Review the proposal", {
    title: "Cove",
    subtitle: "Task due",
  }, {
    notificationAppPath: "/missing/CoveNotifier",
    exists: () => false,
  });
  assert.equal(command.executable, "osascript");
  assert.match(command.args[1], /display notification/);
  assert.match(command.args[1], /with title "Cove" subtitle "Task due"/);
});

test("the installer passes one branded sender identity to every banner lane", () => {
  const installer = readFileSync(path.join(ROOT, "scripts/install-cove-local.sh"), "utf8");
  assert.match(installer, /xcrun --find swiftc/);
  assert.match(installer, /xcrun --sdk macosx --show-sdk-path/);
  assert.match(installer, /-sdk "\$MACOS_SDK"/);
  assert.match(installer, /Cove Notifications\.app/);
  assert.match(installer, /COVE_NOTIFICATION_APP/);
  assert.ok(
    installer.match(/\$NOTIFICATION_PLIST_ENTRY/g)?.length >= 7,
    "expected every notification-capable LaunchAgent to receive the branding paths",
  );
});
