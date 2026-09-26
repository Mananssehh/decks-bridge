// Runs the release gates in scripts/release-common.sh against stand-ins for
// codesign, xcrun stapler, spctl, lipo and PlistBuddy, so the checks that keep
// unsigned, ad-hoc, unnotarized or wrong-architecture builds out of a release
// are exercised on any machine, not only on a Mac during a real release.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "./release-tools.mjs";

const TEAM = "ABCDE12345";
const GOOD_APP_INFO = [
  "Executable=/x/Decks Bridge.app/Contents/MacOS/decks-bridge",
  "Identifier=com.decks.bridge",
  "Format=app bundle with Mach-O thin (arm64)",
  "CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=28+7 location=embedded",
  `Authority=Developer ID Application: Example DJ Tools (${TEAM})`,
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "Timestamp=Oct 1, 2026 at 12:00:00",
  `TeamIdentifier=${TEAM}`,
].join("\n");
const GOOD_SPCTL = [
  "/x/Decks Bridge.app: accepted",
  "source=Notarized Developer ID",
  `origin=Developer ID Application: Example DJ Tools (${TEAM})`,
].join("\n");

// Each stand-in answers from STUB_* variables set per test.
const STUBS = {
  codesign: `#!/usr/bin/env bash
case "$1" in
  --verify) exit "\${STUB_CODESIGN_VERIFY:-0}" ;;
  -dv) printf '%s\\n' "$STUB_CODESIGN_INFO" >&2; exit 0 ;;
esac
echo "unexpected codesign $*" >&2; exit 64
`,
  xcrun: `#!/usr/bin/env bash
[[ "$1 $2" == "stapler validate" ]] || { echo "unexpected xcrun $*" >&2; exit 64; }
exit "\${STUB_STAPLER:-0}"
`,
  spctl: `#!/usr/bin/env bash
printf '%s\\n' "$STUB_SPCTL" >&2
exit "\${STUB_SPCTL_EXIT:-0}"
`,
  lipo: `#!/usr/bin/env bash
[[ "$1" == "-archs" ]] || { echo "unexpected lipo $*" >&2; exit 64; }
printf '%s\\n' "$STUB_LIPO"
`,
  PlistBuddy: `#!/usr/bin/env bash
printf '%s\\n' "$STUB_VERSION"
`,
};

let dir;
let stubs;
let app;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "decks-release-common-"));
  stubs = join(dir, "bin");
  mkdirSync(stubs);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, name), body);
    chmodSync(join(stubs, name), 0o755);
  }
  app = join(dir, "Decks Bridge.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "decks-bridge"), "#!/bin/sh\n");
  chmodSync(join(app, "Contents", "MacOS", "decks-bridge"), 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs one release-common.sh function with the stand-ins first on PATH. */
function run(fn, args, stub = {}) {
  const env = {
    PATH: `${stubs}:${process.env.PATH}`,
    PLISTBUDDY: join(stubs, "PlistBuddy"),
    STUB_CODESIGN_INFO: GOOD_APP_INFO,
    STUB_SPCTL: GOOD_SPCTL,
    STUB_LIPO: "arm64",
    STUB_VERSION: "1.2.3",
    ...stub,
  };
  const result = spawnSync("bash", ["-c", `source scripts/release-common.sh && ${fn} "$@"`, "bash", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

const checkApp = (stub, { version = "1.2.3", arch = "aarch64", path = app } = {}) =>
  run("check_public_app", [path, version, arch], stub);

describe("check_public_app", () => {
  it("accepts a Developer ID signed, notarized, stapled build of the right version and architecture", () => {
    const result = checkApp({ APPLE_TEAM_ID: TEAM });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    [
      "an ad-hoc signature",
      {
        STUB_CODESIGN_INFO: "CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1\nSignature=adhoc\nTeamIdentifier=not set",
        STUB_SPCTL: "/x/Decks Bridge.app: rejected",
        STUB_SPCTL_EXIT: "3",
        STUB_STAPLER: "65",
      },
      /not signed with a Developer ID Application certificate[\s\S]*ad-hoc signature/,
    ],
    [
      "the self-signed beta identity",
      {
        STUB_CODESIGN_INFO: GOOD_APP_INFO.replace(/Authority=Developer ID Application: [^\n]*/, "Authority=Decks Bridge Beta Signing"),
      },
      /not signed with a Developer ID Application certificate/,
    ],
    [
      "a signature without the hardened runtime",
      { STUB_CODESIGN_INFO: GOOD_APP_INFO.replace("flags=0x10000(runtime)", "flags=0x0(none)") },
      /hardened runtime is not enabled/,
    ],
    ["a broken signature", { STUB_CODESIGN_VERIFY: "1" }, /codesign --verify --deep --strict failed/],
    ["a missing notarization ticket", { STUB_STAPLER: "65" }, /no valid stapled notarization ticket/],
    [
      "an unnotarized build",
      {
        STUB_SPCTL: "/x/Decks Bridge.app: rejected\nsource=Unnotarized Developer ID",
        STUB_SPCTL_EXIT: "3",
      },
      /Gatekeeper does not accept it as Notarized Developer ID/,
    ],
    [
      "acceptance only because Gatekeeper is switched off",
      { STUB_SPCTL: "/x/Decks Bridge.app: accepted\noverride=security disabled" },
      /Gatekeeper assessments are disabled on this Mac/,
    ],
    [
      "acceptance as plain Developer ID, without notarization",
      { STUB_SPCTL: "/x/Decks Bridge.app: accepted\nsource=Developer ID" },
      /Gatekeeper does not accept it as Notarized Developer ID/,
    ],
    ["another version", { STUB_VERSION: "1.2.2" }, /CFBundleShortVersionString is '1\.2\.2', expected '1\.2\.3'/],
    ["the other architecture", { STUB_LIPO: "x86_64" }, /architecture is 'x86_64', expected 'arm64' \(aarch64\)/],
    ["a universal binary", { STUB_LIPO: "x86_64 arm64" }, /architecture is 'x86_64 arm64'/],
    ["another team's signature", { APPLE_TEAM_ID: "ZZZZZ99999" }, /not signed by team ZZZZZ99999/],
  ])("rejects %s", (_name, stub, message) => {
    const result = checkApp(stub);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  });

  it("rejects a bundle without the executable", () => {
    const empty = join(dir, "Empty.app");
    mkdirSync(empty, { recursive: true });
    const result = checkApp({}, { path: empty });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing Contents\/MacOS\/decks-bridge/);
  });

  it("checks an Intel build against x86_64", () => {
    expect(checkApp({ STUB_LIPO: "x86_64" }, { arch: "x64" }).status).toBe(0);
    expect(checkApp({ STUB_LIPO: "arm64" }, { arch: "x64" }).status).not.toBe(0);
  });
});

describe("check_public_dmg", () => {
  const DMG_INFO = `Executable=/x/image.dmg\nAuthority=Developer ID Application: Example DJ Tools (${TEAM})\nTeamIdentifier=${TEAM}`;
  const DMG_SPCTL = "/x/image.dmg: accepted\nsource=Notarized Developer ID";
  const checkDmg = (stub) =>
    run("check_public_dmg", [join(dir, "image.dmg")], { STUB_CODESIGN_INFO: DMG_INFO, STUB_SPCTL: DMG_SPCTL, ...stub });

  it("accepts a signed, notarized, stapled disk image", () => {
    expect(checkDmg({}).status).toBe(0);
  });

  it.each([
    ["an unsigned image", { STUB_CODESIGN_VERIFY: "1", STUB_CODESIGN_INFO: "code object is not signed at all" }, /not signed/],
    [
      "an image signed with another identity",
      { STUB_CODESIGN_INFO: "Executable=/x/image.dmg\nAuthority=Decks Bridge Beta Signing" },
      /not signed with a Developer ID Application certificate/,
    ],
    ["an image without a ticket", { STUB_STAPLER: "65" }, /no valid stapled notarization ticket/],
    ["an image accepted as plain Developer ID", { STUB_SPCTL: "/x/image.dmg: accepted\nsource=Developer ID" }, /Gatekeeper does not accept/],
    ["an unnotarized image", { STUB_SPCTL: "/x/image.dmg: rejected\nsource=Unnotarized Developer ID", STUB_SPCTL_EXIT: "3" }, /Gatekeeper does not accept/],
    ["acceptance only because Gatekeeper is switched off", { STUB_SPCTL: "/x/image.dmg: accepted\noverride=security disabled" }, /assessments are disabled/],
  ])("rejects %s", (_name, stub, message) => {
    const result = checkDmg(stub);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  });
});

describe("resolve_arch_tag", () => {
  const resolve = (target, lipo) => run("resolve_arch_tag", [target, app], { STUB_LIPO: lipo });

  it("uses the requested target when the executable matches it", () => {
    expect(resolve("aarch64-apple-darwin", "arm64")).toMatchObject({ status: 0, stdout: "aarch64" });
    expect(resolve("x86_64-apple-darwin", "x86_64")).toMatchObject({ status: 0, stdout: "x64" });
  });

  it("reads the executable when no target was requested", () => {
    expect(resolve("", "x86_64")).toMatchObject({ status: 0, stdout: "x64" });
    expect(resolve("", "arm64")).toMatchObject({ status: 0, stdout: "aarch64" });
  });

  it("refuses an executable that does not match the requested target", () => {
    const result = resolve("x86_64-apple-darwin", "arm64");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/contains a aarch64 build, but x86_64-apple-darwin \(x64\) was requested/);
  });

  it("refuses universal binaries and unsupported targets", () => {
    expect(resolve("", "x86_64 arm64").status).not.toBe(0);
    const universal = resolve("universal-apple-darwin", "arm64");
    expect(universal.status).not.toBe(0);
    expect(universal.stderr).toMatch(/unsupported target 'universal-apple-darwin'/);
  });
});
