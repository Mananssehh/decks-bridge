import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROOT,
  UPDATER_ARTIFACTS,
  buildLatestJson,
  bumpVersion,
  checkReleaseVersion,
  decodeUpdaterPublicKey,
  extractReleaseNotes,
  parseReleaseVersion,
  readUpdaterPublicKey,
  readVersions,
  rfc3339,
  verifyUpdaterSignature,
  versionFromTag,
} from "./release-tools.mjs";

const b64 = (text) => Buffer.from(text).toString("base64");

// Public test vectors from minisign-verify 0.2.5 (the crate tauri-plugin-updater
// uses), wrapped in base64 the way Tauri stores keys and signatures.
const VECTOR_PUBKEY = b64(
  "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n"
);
const VECTOR_LEGACY_SIG = b64(
  "untrusted comment: signature from minisign secret key\n" +
    "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\n" +
    "trusted comment: timestamp:1555779966\tfile:test\n" +
    "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n"
);
const VECTOR_PREHASHED_SIG = b64(
  "untrusted comment: signature from minisign secret key\n" +
    "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n" +
    "trusted comment: timestamp:1556193335\tfile:test\n" +
    "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n"
);

/** An in-memory updater key pair, in Tauri's formats. Never written to disk. */
function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = randomBytes(8);
  const line = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  return { privateKey, keyId, pubkey: b64(`untrusted comment: minisign public key\n${line}\n`) };
}

/** Signs like `tauri signer sign` (prehashed minisign), returning the .sig contents. */
function signLikeTauri(key, data, trustedComment = "timestamp:1790000000\tfile:artifact") {
  const signature = sign(null, createHash("blake2b512").update(data).digest(), key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), key.privateKey);
  const line = Buffer.concat([Buffer.from("ED"), key.keyId, signature]).toString("base64");
  return b64(
    `untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${trustedComment}\n${global.toString("base64")}\n`
  );
}

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "decks-release-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** A throwaway copy of the files that carry the app version. */
function repoCopy() {
  const dir = tempDir();
  mkdirSync(join(dir, "src-tauri"));
  for (const file of [
    "package.json",
    "package-lock.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ]) {
    copyFileSync(join(ROOT, file), join(dir, file));
  }
  return dir;
}

describe("release versions", () => {
  it("accepts MAJOR.MINOR.PATCH with an optional pre-release", () => {
    expect(parseReleaseVersion("1.2.3")).toEqual({ version: "1.2.3", prerelease: false });
    expect(parseReleaseVersion("1.2.3-beta.1")).toEqual({ version: "1.2.3-beta.1", prerelease: true });
    for (const bad of ["v1.2.3", "1.2", "1.2.3+build.1", "01.2.3", ""]) {
      expect(parseReleaseVersion(bad), bad).toBeNull();
    }
  });

  it("reads the version from v-prefixed tags only", () => {
    expect(versionFromTag("v0.2.0")).toEqual({ version: "0.2.0", prerelease: false });
    expect(() => versionFromTag("0.2.0")).toThrow(/v1\.2\.3/);
    expect(() => versionFromTag("v0.2")).toThrow();
  });

  it("finds the same version in every file of this repository", () => {
    const versions = readVersions();
    expect(new Set(Object.values(versions)).size).toBe(1);
  });

  it("requires the tag to match the app version", () => {
    const dir = repoCopy();
    bumpVersion("0.2.0", dir);
    expect(checkReleaseVersion({ root: dir, tag: "v0.2.0" })).toEqual({ version: "0.2.0", prerelease: false });
    expect(() => checkReleaseVersion({ root: dir, tag: "v0.3.0" })).toThrow(/does not match the app version "0.2.0"/);
    expect(() => checkReleaseVersion({ root: dir, tag: "release-1" })).toThrow(/v1\.2\.3/);
  });

  it("rejects a release whose files disagree", () => {
    const dir = repoCopy();
    bumpVersion("0.2.0", dir);
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: "0.1.9" }, null, 2));
    expect(() => checkReleaseVersion({ root: dir, tag: "v0.2.0" })).toThrow(/package.json has version "0.1.9"/);
  });

  it("bumps every version file and round-trips without other changes", () => {
    const dir = repoCopy();
    const files = [
      "package.json",
      "package-lock.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
    ];
    const original = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const originalVersion = readVersions(dir)["src-tauri/tauri.conf.json"];

    bumpVersion("1.2.3", dir);
    expect(Object.values(readVersions(dir))).toEqual(["1.2.3", "1.2.3", "1.2.3"]);
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    expect(lock.version).toBe("1.2.3");
    expect(lock.packages[""].version).toBe("1.2.3");
    expect(readFileSync(join(dir, "src-tauri/Cargo.lock"), "utf8")).toContain(
      'name = "decks-bridge"\nversion = "1.2.3"'
    );

    bumpVersion(originalVersion, dir);
    for (const f of files) expect(readFileSync(join(dir, f), "utf8"), f).toBe(original[f]);
  });

  it("refuses to bump to an invalid version", () => {
    expect(() => bumpVersion("v1.2.3", repoCopy())).toThrow(/no leading "v"/);
  });
});

describe("release notes", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- Work in progress",
    "",
    "## [0.2.0] - 2026-10-01",
    "",
    "### Added",
    "- Update alerts",
    "",
    "## 0.1.1",
    "- Hotfix",
    "",
    "## [0.1.0] - 2026-05-19",
    "",
    "- Initial release.",
    "",
    "[0.2.0]: https://github.com/Mananssehh/decks-bridge/releases/tag/v0.2.0",
  ].join("\n");

  it("extracts exactly the section for the version", () => {
    expect(extractReleaseNotes(changelog, "0.2.0")).toBe("### Added\n- Update alerts");
    expect(extractReleaseNotes(changelog, "0.1.1")).toBe("- Hotfix");
    expect(extractReleaseNotes(changelog, "0.1.0")).toBe("- Initial release.");
  });

  it("fails when the section is missing or empty", () => {
    expect(() => extractReleaseNotes(changelog, "0.3.0")).toThrow(/no "## \[0.3.0\]" section/);
    expect(() => extractReleaseNotes("## [0.4.0]\n\n## [0.3.0]\n- x", "0.4.0")).toThrow(/empty/);
  });

  it("does not match a longer version with the same prefix", () => {
    expect(() => extractReleaseNotes("## [0.2.0-beta.1]\n- beta", "0.2.0")).toThrow(/no "## \[0.2.0\]"/);
  });

  it("has notes for the current version in this repository's CHANGELOG.md", () => {
    const version = readVersions()["src-tauri/tauri.conf.json"];
    expect(extractReleaseNotes(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version)).not.toBe("");
  });
});

describe("updater signatures", () => {
  it("accepts minisign-verify's own legacy and prehashed test vectors", () => {
    const data = Buffer.from("test");
    expect(verifyUpdaterSignature({ data, signature: VECTOR_LEGACY_SIG, pubkey: VECTOR_PUBKEY })).toEqual({
      keyId: "E7620F1842B4E81F",
      prehashed: false,
    });
    expect(verifyUpdaterSignature({ data, signature: VECTOR_PREHASHED_SIG, pubkey: VECTOR_PUBKEY })).toEqual({
      keyId: "E7620F1842B4E81F",
      prehashed: true,
    });
  });

  it("rejects modified data", () => {
    expect(() =>
      verifyUpdaterSignature({ data: Buffer.from("Test"), signature: VECTOR_LEGACY_SIG, pubkey: VECTOR_PUBKEY })
    ).toThrow(/does not match the file contents/);
  });

  it("rejects a signature from a different key with the key ids in the message", () => {
    const key = makeKey();
    const data = randomBytes(1024);
    expect(() =>
      verifyUpdaterSignature({ data, signature: signLikeTauri(key, data), pubkey: VECTOR_PUBKEY })
    ).toThrow(/but the app trusts key E7620F1842B4E81F/);
  });

  it("rejects an altered trusted comment", () => {
    const key = makeKey();
    const data = randomBytes(1024);
    const text = Buffer.from(signLikeTauri(key, data), "base64")
      .toString("utf8")
      .replace("file:artifact", "file:other");
    expect(() => verifyUpdaterSignature({ data, signature: b64(text), pubkey: key.pubkey })).toThrow(
      /trusted comment has been altered/
    );
  });

  it("rejects garbage instead of crashing", () => {
    expect(() =>
      verifyUpdaterSignature({ data: Buffer.from("x"), signature: "%%%", pubkey: VECTOR_PUBKEY })
    ).toThrow(/not valid base64/);
    expect(() =>
      verifyUpdaterSignature({ data: Buffer.from("x"), signature: b64("just\ntext"), pubkey: VECTOR_PUBKEY })
    ).toThrow();
  });

  it("decodes the public key the app ships with", () => {
    const { keyId, key } = decodeUpdaterPublicKey(readUpdaterPublicKey());
    expect(keyId).toHaveLength(8);
    expect(key).toHaveLength(32);
  });
});

describe("latest.json", () => {
  function writeArtifacts(dir, version, key, { skip = [], corrupt = [] } = {}) {
    for (const { platform, asset } of UPDATER_ARTIFACTS) {
      if (skip.includes(platform)) continue;
      const data = randomBytes(2048);
      writeFileSync(join(dir, asset(version)), data);
      const signed = corrupt.includes(platform) ? Buffer.concat([data, Buffer.from("!")]) : data;
      writeFileSync(join(dir, `${asset(version)}.sig`), `${signLikeTauri(key, signed)}\n`);
    }
  }

  it("lists every platform with its signature and release download URL", () => {
    const key = makeKey();
    const dir = tempDir();
    writeArtifacts(dir, "0.2.0", key);

    const manifest = buildLatestJson({
      version: "0.2.0",
      repo: "Mananssehh/decks-bridge",
      notes: "- Update alerts",
      assetsDir: dir,
      pubkey: key.pubkey,
      pubDate: new Date("2026-10-01T12:34:56.789Z"),
    });

    expect(manifest.version).toBe("0.2.0");
    expect(manifest.notes).toBe("- Update alerts");
    expect(manifest.pub_date).toBe("2026-10-01T12:34:56Z");
    expect(Object.keys(manifest.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
    expect(manifest.platforms["darwin-aarch64"].url).toBe(
      "https://github.com/Mananssehh/decks-bridge/releases/download/v0.2.0/Decks.Bridge_0.2.0_aarch64.app.tar.gz"
    );
    expect(manifest.platforms["windows-x86_64"].url).toMatch(/\/v0\.2\.0\/Decks\.Bridge_0\.2\.0_x64-setup\.nsis\.zip$/);
    const sig = readFileSync(join(dir, "Decks.Bridge_0.2.0_x64.app.tar.gz.sig"), "utf8").trim();
    expect(manifest.platforms["darwin-x86_64"].signature).toBe(sig);
  });

  it("refuses to publish when an artifact is missing", () => {
    const key = makeKey();
    const dir = tempDir();
    writeArtifacts(dir, "0.2.0", key, { skip: ["darwin-x86_64"] });
    expect(() =>
      buildLatestJson({ version: "0.2.0", repo: "o/r", notes: "n", assetsDir: dir, pubkey: key.pubkey })
    ).toThrow(/Missing updater artifacts: Decks\.Bridge_0\.2\.0_x64\.app\.tar\.gz/);
  });

  it("refuses to publish an artifact whose signature does not verify", () => {
    const key = makeKey();
    const dir = tempDir();
    writeArtifacts(dir, "0.2.0", key, { corrupt: ["windows-x86_64"] });
    expect(() =>
      buildLatestJson({ version: "0.2.0", repo: "o/r", notes: "n", assetsDir: dir, pubkey: key.pubkey })
    ).toThrow(/x64-setup\.nsis\.zip: The signature does not match/);
  });

  it("refuses artifacts signed with a key the app does not trust", () => {
    const dir = tempDir();
    writeArtifacts(dir, "0.2.0", makeKey());
    expect(() =>
      buildLatestJson({ version: "0.2.0", repo: "o/r", notes: "n", assetsDir: dir, pubkey: makeKey().pubkey })
    ).toThrow(/but the app trusts key/);
  });

  it("validates its inputs", () => {
    const pubkey = makeKey().pubkey;
    expect(() => buildLatestJson({ version: "v0.2.0", repo: "o/r", notes: "", assetsDir: ".", pubkey })).toThrow(
      /Invalid release version/
    );
    expect(() => buildLatestJson({ version: "0.2.0", repo: "nope", notes: "", assetsDir: ".", pubkey })).toThrow(
      /Invalid repository/
    );
  });

  it("formats dates as RFC 3339 without fractions", () => {
    expect(rfc3339(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03:04:05Z");
  });
});
