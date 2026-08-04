import assert from "node:assert/strict";
import test from "node:test";
import { parseFromHeader } from "../src/lib/email/from-header.ts";

test("a quoted display name splits cleanly from the angle address", () => {
  assert.deepEqual(parseFromHeader('"Sarah Chen" <sarah@work.com>'), {
    displayName: "Sarah Chen",
    address: "sarah@work.com",
  });
});

test("an unquoted display name splits cleanly", () => {
  assert.deepEqual(parseFromHeader("Sarah Chen <Sarah@Work.com>"), {
    displayName: "Sarah Chen",
    address: "sarah@work.com",
  });
});

test("a bare address falls back to the local part as the name", () => {
  assert.deepEqual(parseFromHeader("sarah@work.com"), {
    displayName: "sarah",
    address: "sarah@work.com",
  });
});

test("an angle-only address falls back to the local part as the name", () => {
  assert.deepEqual(parseFromHeader("<sarah@work.com>"), {
    displayName: "sarah",
    address: "sarah@work.com",
  });
});

test("a comment becomes the name when no display name exists", () => {
  assert.deepEqual(parseFromHeader("sarah@work.com (Sarah Chen)"), {
    displayName: "Sarah Chen",
    address: "sarah@work.com",
  });
});

test("comments are stripped from a display name", () => {
  assert.deepEqual(parseFromHeader("Sarah Chen (Work) <sarah@work.com>"), {
    displayName: "Sarah Chen",
    address: "sarah@work.com",
  });
});

test("quoted names keep angle brackets and escapes without breaking the address", () => {
  assert.deepEqual(parseFromHeader('"Weird <Name> \\"Quoted\\"" <a@b.io>'), {
    displayName: 'Weird <Name> "Quoted"',
    address: "a@b.io",
  });
});

test("base64 encoded-word display names decode", () => {
  assert.deepEqual(
    parseFromHeader("=?utf-8?B?U2FyYWggQ2hlbg==?= <sarah@work.com>"),
    { displayName: "Sarah Chen", address: "sarah@work.com" },
  );
});

test("quoted-printable encoded-word display names decode", () => {
  assert.deepEqual(
    parseFromHeader("=?UTF-8?Q?Jos=C3=A9_O=27Neill?= <jose@work.com>"),
    { displayName: "José O'Neill", address: "jose@work.com" },
  );
});

test("an unparseable encoded word passes through safely", () => {
  const parsed = parseFromHeader("=?x-unknown?Z?garbage?= <mystery@work.com>");
  assert.equal(parsed.address, "mystery@work.com");
  assert.equal(parsed.displayName, "=?x-unknown?Z?garbage?=");
});

test("an empty header yields empty parts", () => {
  assert.deepEqual(parseFromHeader(""), { displayName: "", address: "" });
});

test("whitespace and case in addresses are normalized", () => {
  assert.deepEqual(parseFromHeader("  Sarah   Chen   < SARAH@Work.com >  "), {
    displayName: "Sarah Chen",
    address: "sarah@work.com",
  });
});

test("a malformed unterminated angle bracket still yields the address", () => {
  assert.deepEqual(parseFromHeader("Sarah Chen <sarah@work.com"), {
    displayName: "Sarah Chen",
    address: "sarah@work.com",
  });
});

test("a display name with no address stays a name with an empty address", () => {
  assert.deepEqual(parseFromHeader('"Sarah Chen"'), {
    displayName: "Sarah Chen",
    address: "",
  });
});
