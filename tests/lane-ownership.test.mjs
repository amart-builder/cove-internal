import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkLaneOwnership,
  claimLaneOwnership,
  laneInstalledForMachine,
  markLaneInstalled,
  readLaneOwner,
} from "../scripts/lib/cove-lane-ownership.mjs";
import {
  machineIdentityPaths,
  resolveMachineIdentity,
} from "../src/lib/machine-identity.mjs";

const SOLO_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const MINI_ID = "33333333-3333-4333-8333-333333333333";

function identity(id, hostname) {
  return { id, hostname };
}

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-lane-ownership-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a single Mac claims both lanes and another plain install cannot steal them", (t) => {
  const dataDir = fixture(t);
  const solo = identity(SOLO_ID, "solo-mac.local");
  const renamedSolo = identity(SOLO_ID, "solo-mac.lan");
  const second = identity(SECOND_ID, "second-mac.local");
  for (const lane of ["meeting_watch", "progress"]) {
    assert.equal(
      claimLaneOwnership({
        dataDir,
        lane,
        identity: solo,
        now: new Date("2026-07-29T12:00:00.000Z"),
      }).claimed,
      true,
    );
    assert.deepEqual(readLaneOwner(dataDir, lane), {
      id: SOLO_ID,
      hostnameAtClaim: "solo-mac.local",
      claimedAt: "2026-07-29T12:00:00.000Z",
    });
    assert.deepEqual(
      checkLaneOwnership({ dataDir, lane, identity: renamedSolo }),
      {
        identity: renamedSolo,
        owner: {
          id: SOLO_ID,
          hostnameAtClaim: "solo-mac.local",
          claimedAt: "2026-07-29T12:00:00.000Z",
        },
        shouldRun: true,
      },
    );
    const skipped = claimLaneOwnership({
      dataDir,
      lane,
      identity: second,
    });
    assert.equal(skipped.claimed, false);
    assert.equal(skipped.owner.id, SOLO_ID);
  }
});

test("a Mini claim replaces both owners and install markers are machine-id scoped", (t) => {
  const dataDir = fixture(t);
  const macbook = identity(SOLO_ID, "macbook.local");
  const mini = identity(MINI_ID, "mini.local");
  for (const lane of ["meeting_watch", "progress"]) {
    claimLaneOwnership({ dataDir, lane, identity: macbook });
    const claimed = claimLaneOwnership({
      dataDir,
      lane,
      identity: mini,
      force: true,
    });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.replacedOwner.id, SOLO_ID);
    assert.equal(readLaneOwner(dataDir, lane).id, MINI_ID);
  }

  markLaneInstalled({
    dataDir,
    lane: "meeting_watch",
    identity: mini,
  });
  markLaneInstalled({
    dataDir,
    lane: "progress_reconcile",
    identity: mini,
  });
  assert.equal(
    laneInstalledForMachine({
      dataDir,
      lane: "meeting_watch",
      identity: identity(MINI_ID, "mini.lan"),
    }),
    true,
  );
  assert.equal(
    laneInstalledForMachine({
      dataDir,
      lane: "meeting_watch",
      identity: macbook,
    }),
    false,
  );
});

test("machine identity persists its UUID while refreshing hostname metadata", (t) => {
  const dir = fixture(t);
  const homeDir = path.join(dir, "home");
  const first = resolveMachineIdentity({
    homeDir,
    hostname: "alex-mac.local",
    randomUUID: () => SOLO_ID,
  });
  const second = resolveMachineIdentity({
    homeDir,
    hostname: "alex-mac.lan",
    randomUUID: () => {
      throw new Error("must not generate another UUID");
    },
  });
  assert.equal(first.id, SOLO_ID);
  assert.equal(second.id, SOLO_ID);
  assert.equal(second.hostname, "alex-mac.lan");
  assert.equal(second.file, machineIdentityPaths(homeDir).primary);
  assert.equal(statSync(second.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(second.file, "utf8")), {
    id: SOLO_ID,
    hostname: "alex-mac.lan",
  });
});

test("machine identity falls back outside Application Support when needed", (t) => {
  const dir = fixture(t);
  const blockedParent = path.join(dir, "not-a-directory");
  const fallback = path.join(dir, ".cove-machine-id");
  writeFileSync(blockedParent, "blocked");
  const resolved = resolveMachineIdentity({
    hostname: "fallback-mac.local",
    randomUUID: () => SECOND_ID,
    paths: {
      primary: path.join(blockedParent, "machine-id"),
      fallback,
    },
  });
  assert.equal(resolved.id, SECOND_ID);
  assert.equal(resolved.file, fallback);
  assert.equal(statSync(fallback).mode & 0o777, 0o600);
});

test("legacy hostname-only ownership is reclaimed with a machine id", (t) => {
  const dataDir = fixture(t);
  writeFileSync(
    path.join(dataDir, "cove-lane-owners.json"),
    JSON.stringify({
      version: 1,
      lanes: {
        meeting_watch: {
          hostname: "old-host.local",
          claimed_at: "2026-07-29T12:00:00.000Z",
        },
      },
    }),
  );
  assert.equal(readLaneOwner(dataDir, "meeting_watch"), undefined);
  const claimed = claimLaneOwnership({
    dataDir,
    lane: "meeting_watch",
    identity: identity(SOLO_ID, "new-host.lan"),
  });
  assert.equal(claimed.claimed, true);
  assert.equal(readLaneOwner(dataDir, "meeting_watch").id, SOLO_ID);
});
