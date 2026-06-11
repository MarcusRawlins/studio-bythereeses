import assert from "node:assert/strict";
import {
  CANONICAL_ORIGIN,
  evaluateSourceDrift,
  readCopyState,
  summarizeCopy,
} from "./check-source-drift.mjs";

const primary = {
  path: "/Volumes/reeseai-memory/code/reese-photography-crm",
  present: true,
  isGitRepo: true,
  branch: "crm-drift-guard",
  head: "abc123def456",
  dirty: false,
  originUrl: CANONICAL_ORIGIN,
  upstream: "origin/crm-platform-baseline",
  ahead: 0,
  behind: 0,
};

const alignedCopies = [
  primary,
  {
    path: "/Users/tyler-macmini/code/reese-photography-crm",
    present: true,
    isGitRepo: true,
    branch: "crm-drift-guard",
    head: "abc123def456",
    dirty: false,
    originUrl: CANONICAL_ORIGIN,
    upstream: "origin/crm-platform-baseline",
    ahead: 0,
    behind: 0,
  },
];

const aligned = evaluateSourceDrift({ primary, copies: alignedCopies });
assert.deepEqual(aligned.errors, []);
assert.deepEqual(aligned.warnings, []);
assert.equal(aligned.aligned, true);

const headDrift = evaluateSourceDrift({
  primary,
  copies: [
    primary,
    {
      ...alignedCopies[1],
      head: "deadbeef0000",
      branch: "main",
    },
  ],
});
assert.equal(headDrift.errors.length, 1);
assert.match(headDrift.errors[0], /disagree on HEAD/);
assert.match(headDrift.warnings[0], /different branches/);

const originDrift = evaluateSourceDrift({
  primary: { ...primary, originUrl: "https://example.com/other.git" },
  copies: alignedCopies,
});
assert.deepEqual(originDrift.errors, [
  `Primary origin URL (https://example.com/other.git) does not match canonical (${CANONICAL_ORIGIN}).`,
]);

const dirtyAndUpstream = evaluateSourceDrift({
  primary: { ...primary, dirty: true, upstream: null, ahead: null, behind: null },
  copies: [
    {
      ...alignedCopies[1],
      dirty: true,
      upstream: null,
    },
    {
      path: "/Users/tyler-macmini/Documents/studio-bythereeses",
      present: false,
    },
  ],
});
assert.deepEqual(dirtyAndUpstream.errors, []);
assert.ok(dirtyAndUpstream.warnings.some((warning) => warning.includes("Primary worktree is dirty")));
assert.ok(dirtyAndUpstream.warnings.some((warning) => warning.includes("No upstream tracking branch")));
assert.ok(dirtyAndUpstream.warnings.some((warning) => warning.includes("Known copy absent")));

const aheadBehind = evaluateSourceDrift({
  primary: { ...primary, ahead: 2, behind: 1 },
  copies: alignedCopies,
});
assert.ok(aheadBehind.warnings.some((warning) => warning.includes("2 ahead and 1 behind")));

assert.match(
  summarizeCopy({
    path: "/tmp/repo",
    present: true,
    isGitRepo: true,
    branch: "main",
    head: "abc123def456",
    dirty: true,
    originUrl: CANONICAL_ORIGIN,
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
  }),
  /main@abc123d dirty/,
);

const mockExists = (target) => target === "/tmp/mock-repo/.git" || target === "/tmp/mock-repo";
const mockRun = (command, args) => {
  if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
    return { status: 0, stdout: "mockhead123456", stderr: "" };
  }
  if (command === "git" && args[0] === "rev-parse" && args.includes("@{u}")) {
    return { status: 0, stdout: "origin/feature/test", stderr: "" };
  }
  if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
    return { status: 0, stdout: "feature/test", stderr: "" };
  }
  if (command === "git" && args[0] === "status") {
    return { status: 0, stdout: " M README.md\n", stderr: "" };
  }
  if (command === "git" && args[0] === "remote") {
    return { status: 0, stdout: CANONICAL_ORIGIN, stderr: "" };
  }
  if (command === "git" && args[0] === "rev-list") {
    return { status: 0, stdout: "0\t3", stderr: "" };
  }
  return { status: 1, stdout: "", stderr: "unexpected git command" };
};

const read = readCopyState("/tmp/mock-repo", { exists: mockExists, run: mockRun });
assert.equal(read.branch, "feature/test");
assert.equal(read.head, "mockhead123456");
assert.equal(read.dirty, true);
assert.equal(read.originUrl, CANONICAL_ORIGIN);
assert.equal(read.upstream, "origin/feature/test");
assert.equal(read.ahead, 3);
assert.equal(read.behind, 0);

console.log("check source drift tests passed");