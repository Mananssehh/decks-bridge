#!/usr/bin/env node
// Release helpers for the tag-triggered release workflow
// (.github/workflows/release.yml). Also usable locally:
//
//   node scripts/release-tools.mjs check-version [--tag v1.2.3]
//   node scripts/release-tools.mjs bump-version 1.2.3
//   node scripts/release-tools.mjs release-notes 1.2.3 [--out notes.md]
//   node scripts/release-tools.mjs verify-signature <file> [<file>.sig]
//   node scripts/release-tools.mjs check-secrets
//   node scripts/release-tools.mjs check-release-files --version 1.2.3 --dir dir \
//        [--platforms darwin-aarch64,darwin-x86_64] [--final]
//   node scripts/release-tools.mjs latest-json --version 1.2.3 --repo owner/name \
//        --assets-dir dir --notes-file notes.md [--platforms …] [--out dir/latest.json]
//
// The only key this script ever reads is the PUBLIC updater key in
// src-tauri/tauri.conf.json. Signing happens with `tauri signer sign`.
// check-secrets only reports which secret NAMES are missing, never a value.

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The files each platform contributes to a release, keyed by the platform names
 * tauri-plugin-updater looks up in latest.json (`{os}-{arch}`): downloads for
 * new installs, and the updater archive (published with its `.sig`). No spaces,
 * so GitHub keeps the names verbatim. scripts/release-common.sh produces the
 * macOS names; release-tools.test.mjs checks that the two agree.
 */
export const PLATFORM_FILES = {
  "darwin-aarch64": {
    updater: (v) => `Decks.Bridge_${v}_aarch64.app.tar.gz`,
    downloads: (v) => [`Decks.Bridge_${v}_aarch64.dmg`, `Decks.Bridge_${v}_aarch64.app.zip`],
  },
  "darwin-x86_64": {
    updater: (v) => `Decks.Bridge_${v}_x64.app.tar.gz`,
    downloads: (v) => [`Decks.Bridge_${v}_x64.dmg`, `Decks.Bridge_${v}_x64.app.zip`],
  },
  // Built by scripts/build-release-windows.ps1 but not published yet; see
  // RELEASE.md → "Enabling Windows releases later".
  "windows-x86_64": {
    updater: (v) => `Decks.Bridge_${v}_x64-setup.nsis.zip`,
    downloads: (v) => [`Decks.Bridge_${v}_x64-setup.exe`, `Decks.Bridge_${v}_x64-portable.zip`],
  },
};

/** What a release publishes by default: macOS only (Apple Silicon and Intel). */
export const RELEASE_PLATFORMS = Object.freeze(["darwin-aarch64", "darwin-x86_64"]);

/** Added to a release after the platform files are complete and verified. */
export const RELEASE_EXTRA_FILES = Object.freeze(["latest.json", "SHA256SUMS.txt"]);

/** Returns the platforms without duplicates; throws on an empty list or an unknown platform. */
export function knownPlatforms(platforms) {
  const unique = [...new Set(platforms)];
  if (!unique.length) throw new Error("No platforms given.");
  const unknown = unique.filter((p) => !Object.hasOwn(PLATFORM_FILES, p));
  if (unknown.length) {
    throw new Error(
      `Unknown platform(s): ${unknown.join(", ")}. Known: ${Object.keys(PLATFORM_FILES).join(", ")}.`
    );
  }
  return unique;
}

/** Parses a --platforms value such as "darwin-aarch64,darwin-x86_64". */
export function parsePlatforms(list) {
  return knownPlatforms(String(list ?? "").split(",").map((p) => p.trim()).filter(Boolean));
}

/** Every file one platform contributes: downloads, updater archive, its signature. */
export function platformReleaseFiles(platform, version) {
  const { updater, downloads } = PLATFORM_FILES[knownPlatforms([platform])[0]];
  return [...downloads(version), updater(version), `${updater(version)}.sig`];
}

/** The exact file set of a release, sorted. `final` adds latest.json and SHA256SUMS.txt. */
export function expectedReleaseFiles({ version, platforms = RELEASE_PLATFORMS, final = false }) {
  if (!parseReleaseVersion(version)) throw new Error(`Invalid release version "${version}".`);
  const files = knownPlatforms(platforms).flatMap((p) => platformReleaseFiles(p, version));
  if (final) files.push(...RELEASE_EXTRA_FILES);
  return files.sort();
}

/**
 * Compares `dir` with the exact file set of a release: every expected file
 * present and non-empty, and nothing else (a stray file would be published
 * too). Returns the problems found; an empty list means the set is complete.
 */
export function checkReleaseFiles({ dir, version, platforms = RELEASE_PLATFORMS, final = false }) {
  const expected = expectedReleaseFiles({ version, platforms, final });
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [`${dir} is not a directory.`];
  const problems = [];
  for (const name of expected) {
    const file = join(dir, name);
    if (!existsSync(file)) problems.push(`missing: ${name}`);
    else if (!statSync(file).isFile()) problems.push(`not a regular file: ${name}`);
    else if (statSync(file).size === 0) problems.push(`empty: ${name}`);
  }
  for (const name of readdirSync(dir).sort()) {
    if (!expected.includes(name)) problems.push(`unexpected: ${name}`);
  }
  return problems;
}

// ── Versions ──────────────────────────────────────────────────────────────────

// MAJOR.MINOR.PATCH[-prerelease]; no "v", no build metadata (it would be
// ignored by version comparison, so it cannot distinguish two releases).
const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function parseReleaseVersion(version) {
  const m = RELEASE_VERSION.exec(version ?? "");
  return m ? { version, prerelease: m[4] !== undefined } : null;
}

export function versionFromTag(tag) {
  const parsed = /^v/.test(tag ?? "") ? parseReleaseVersion(tag.slice(1)) : null;
  if (!parsed) {
    throw new Error(`Release tags must look like v1.2.3 or v1.2.3-beta.1; got "${tag}".`);
  }
  return parsed;
}

const VERSION_FILES = ["src-tauri/tauri.conf.json", "package.json", "src-tauri/Cargo.toml"];

function cargoPackageVersion(toml) {
  let inPackage = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inPackage = header[1].trim() === "package";
      continue;
    }
    const m = inPackage && /^\s*version\s*=\s*"([^"]*)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** The version recorded in each file that must agree for a release. */
export function readVersions(root = ROOT) {
  const read = (file) => readFileSync(join(root, file), "utf8");
  return {
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version ?? null,
    "package.json": JSON.parse(read("package.json")).version ?? null,
    "src-tauri/Cargo.toml": cargoPackageVersion(read("src-tauri/Cargo.toml")),
  };
}

/**
 * Asserts the app version is releasable and, when `tag` is given, that the tag
 * names exactly that version. tauri.conf.json is what the installed app
 * reports at runtime; if it disagreed with the tag, the updater would offer
 * the same "update" forever after installing it.
 */
export function checkReleaseVersion({ root = ROOT, tag } = {}) {
  const versions = readVersions(root);
  const appVersion = versions["src-tauri/tauri.conf.json"];
  const problems = [];

  const parsed = parseReleaseVersion(appVersion);
  if (!parsed) {
    problems.push(`src-tauri/tauri.conf.json version "${appVersion}" is not MAJOR.MINOR.PATCH[-prerelease].`);
  }
  for (const file of VERSION_FILES) {
    if (versions[file] !== appVersion) {
      problems.push(`${file} has version "${versions[file]}" but src-tauri/tauri.conf.json has "${appVersion}".`);
    }
  }
  if (tag !== undefined) {
    try {
      const fromTag = versionFromTag(tag);
      if (fromTag.version !== appVersion) {
        problems.push(
          `Tag ${tag} does not match the app version "${appVersion}". Run ` +
            `"npm run release:version -- ${fromTag.version}", commit, and tag that commit.`
        );
      }
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return parsed;
}

function rewriteJson(path, mutate) {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text);
  mutate(data);
  const trailingNewline = text.endsWith("\n") ? "\n" : "";
  writeFileSync(path, JSON.stringify(data, null, 2) + trailingNewline);
}

function rewriteText(path, pattern, replacement, what) {
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) throw new Error(`Could not find ${what} in ${path}.`);
  writeFileSync(path, text.replace(pattern, replacement));
}

/** Sets the app version everywhere it is recorded. */
export function bumpVersion(version, root = ROOT) {
  if (!parseReleaseVersion(version)) {
    throw new Error(`"${version}" is not MAJOR.MINOR.PATCH[-prerelease] (no leading "v").`);
  }
  rewriteJson(join(root, "src-tauri/tauri.conf.json"), (conf) => {
    conf.version = version;
  });
  rewriteJson(join(root, "package.json"), (pkg) => {
    pkg.version = version;
  });
  const lock = join(root, "package-lock.json");
  if (existsSync(lock)) {
    rewriteJson(lock, (data) => {
      data.version = version;
      if (data.packages?.[""]) data.packages[""].version = version;
    });
  }
  rewriteText(
    join(root, "src-tauri/Cargo.toml"),
    /(^\[package\][^[]*?^version\s*=\s*")[^"]*(")/m,
    `$1${version}$2`,
    "the [package] version"
  );
  const cargoLock = join(root, "src-tauri/Cargo.lock");
  if (existsSync(cargoLock)) {
    rewriteText(
      cargoLock,
      /(\[\[package\]\]\r?\nname = "decks-bridge"\r?\nversion = ")[^"]*(")/,
      `$1${version}$2`,
      "the decks-bridge package entry"
    );
  }
}

// ── Release notes ─────────────────────────────────────────────────────────────

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the CHANGELOG.md section for `version` ("## [1.2.3] - date" or
 * "## 1.2.3"). Writing it is the deliberate step that makes a release: the
 * text is what DJs see in the update alert.
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "## [${version}]" section. Write the release notes before tagging.`);
  }
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end === -1) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .filter((line) => !/^\[[^\]]+\]:\s*\S/.test(line)) // link reference definitions
    .join("\n")
    .trim();
  if (!body) throw new Error(`The CHANGELOG.md section for ${version} is empty.`);
  return body;
}

// ── Updater signatures (minisign, as verified by tauri-plugin-updater) ────────

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function strictBase64(text, what) {
  const trimmed = (text ?? "").trim();
  if (!BASE64.test(trimmed)) throw new Error(`${what} is not valid base64.`);
  return Buffer.from(trimmed, "base64");
}

function keyIdHex(keyId) {
  // minisign prints the little-endian key id most-significant byte first.
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/** Decodes plugins.updater.pubkey: base64 of a minisign .pub file. */
export function decodeUpdaterPublicKey(pubkey) {
  const lines = strictBase64(pubkey, "The updater public key").toString("utf8").split(/\r?\n/);
  const bin = strictBase64(lines[1], "The updater public key's key line");
  const alg = bin.subarray(0, 2).toString("latin1");
  if (bin.length !== 42 || (alg !== "Ed" && alg !== "ED")) {
    throw new Error("The updater public key is not a minisign Ed25519 public key.");
  }
  return { keyId: bin.subarray(2, 10), key: bin.subarray(10, 42) };
}

/** Decodes a `.sig` produced by `tauri signer sign`: base64 of a minisign signature file. */
export function decodeUpdaterSignature(signature) {
  const lines = strictBase64(signature, "The signature").toString("utf8").split(/\r?\n/);
  const bin = strictBase64(lines[1], "The signature line");
  const trusted = lines[2] ?? "";
  const global = strictBase64(lines[3], "The global signature line");
  const alg = bin.subarray(0, 2).toString("latin1");
  if (bin.length !== 74 || global.length !== 64 || !trusted.startsWith("trusted comment: ")) {
    throw new Error("The signature is not a minisign signature.");
  }
  if (alg !== "Ed" && alg !== "ED") throw new Error(`Unsupported signature algorithm "${alg}".`);
  return {
    prehashed: alg === "ED",
    keyId: bin.subarray(2, 10),
    signature: bin.subarray(10, 74),
    trustedComment: trusted.slice("trusted comment: ".length),
    globalSignature: global,
  };
}

/**
 * Verifies `data` against a Tauri updater signature exactly like
 * tauri-plugin-updater does (minisign-verify with legacy signatures allowed).
 * Throws with an actionable message on any mismatch.
 */
export function verifyUpdaterSignature({ data, signature, pubkey }) {
  const pk = decodeUpdaterPublicKey(pubkey);
  const sig = decodeUpdaterSignature(signature);
  if (!pk.keyId.equals(sig.keyId)) {
    throw new Error(
      `Signed with updater key ${keyIdHex(sig.keyId)}, but the app trusts key ${keyIdHex(pk.keyId)} ` +
        "(plugins.updater.pubkey). TAURI_SIGNING_PRIVATE_KEY must be the matching private key."
    );
  }
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pk.key.toString("base64url") },
    format: "jwk",
  });
  const message = sig.prehashed ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, key, sig.signature)) {
    throw new Error("The signature does not match the file contents.");
  }
  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!verify(null, globalMessage, key, sig.globalSignature)) {
    throw new Error("The signature's trusted comment has been altered.");
  }
  return { keyId: keyIdHex(pk.keyId), prehashed: sig.prehashed };
}

export function readUpdaterPublicKey(root = ROOT) {
  const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const pubkey = conf.plugins?.updater?.pubkey;
  if (!pubkey) throw new Error("src-tauri/tauri.conf.json has no plugins.updater.pubkey.");
  return pubkey;
}

// ── latest.json ───────────────────────────────────────────────────────────────

/** RFC 3339 without fractional seconds, e.g. 2026-09-24T18:00:00Z. */
export function rfc3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Builds the static updater manifest for a release. Every listed platform's
 * artifact and signature must be present in `assetsDir`, and every signature
 * must verify against the app's public key — so a release that installed apps
 * could not accept is never published. Only `platforms` are listed: an
 * installed app on any other platform finds no entry and is not offered it.
 */
export function buildLatestJson({
  version,
  repo,
  notes,
  assetsDir,
  pubkey,
  pubDate = new Date(),
  platforms: releasePlatforms = RELEASE_PLATFORMS,
}) {
  if (!parseReleaseVersion(version)) throw new Error(`Invalid release version "${version}".`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error(`Invalid repository "${repo}".`);
  const tag = `v${version}`;
  const platforms = {};
  const missing = [];

  for (const platform of knownPlatforms(releasePlatforms)) {
    const name = PLATFORM_FILES[platform].updater(version);
    const file = join(assetsDir, name);
    if (!existsSync(file) || !existsSync(`${file}.sig`)) {
      missing.push(`${name} (+ .sig)`);
      continue;
    }
    const signature = readFileSync(`${file}.sig`, "utf8").trim();
    try {
      verifyUpdaterSignature({ data: readFileSync(file), signature, pubkey });
    } catch (err) {
      throw new Error(`${name}: ${err.message}`);
    }
    platforms[platform] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
    };
  }
  if (missing.length) throw new Error(`Missing updater artifacts: ${missing.join(", ")}`);

  return { version, notes, pub_date: rfc3339(pubDate), platforms };
}

// ── Release secrets ───────────────────────────────────────────────────────────

/** Actions secrets every release needs (RELEASE.md → Secrets). */
export const REQUIRED_SECRETS = Object.freeze([
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]);

/** Notarization needs one complete set: an App Store Connect API key, or an Apple ID. */
export const NOTARIZATION_SECRET_SETS = Object.freeze([
  Object.freeze(["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]),
  Object.freeze(["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]),
]);

/** Every secret name the release workflow may read. */
export const RELEASE_SECRET_NAMES = Object.freeze([...REQUIRED_SECRETS, ...NOTARIZATION_SECRET_SETS.flat()]);

/**
 * Checks that the release secrets are configured, from their environment
 * variables. Problems name secrets only; values are never included.
 */
export function checkReleaseSecrets(env) {
  const has = (name) => typeof env[name] === "string" && env[name].trim() !== "";
  const problems = [];
  const missing = REQUIRED_SECRETS.filter((name) => !has(name));
  if (missing.length) problems.push(`Missing secrets: ${missing.join(", ")}.`);
  if (!NOTARIZATION_SECRET_SETS.some((set) => set.every(has))) {
    const options = NOTARIZATION_SECRET_SETS.map((set) => {
      const absent = set.filter((name) => !has(name));
      return `${set.join(" + ")} (missing ${absent.join(", ")})`;
    });
    problems.push(`No complete notarization credentials. Set ${options.join(", or ")}.`);
  }
  if (has("APPLE_SIGNING_IDENTITY") && !env.APPLE_SIGNING_IDENTITY.trim().startsWith("Developer ID Application: ")) {
    problems.push(
      'APPLE_SIGNING_IDENTITY must name a "Developer ID Application: …" certificate; ' +
        "Gatekeeper rejects anything else in a downloaded app."
    );
  }
  return problems;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(["final"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && BOOLEAN_FLAGS.has(arg.slice(2))) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      flags[arg.slice(2)] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function required(value, name) {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

const COMMANDS = {
  // Prints GitHub-output lines (version=…, prerelease=…) on stdout.
  "check-version"({ flags }) {
    const { version, prerelease } = checkReleaseVersion({ tag: flags.tag });
    console.error(`Release version ${version}${prerelease ? " (pre-release)" : ""} is consistent.`);
    console.log(`version=${version}`);
    console.log(`prerelease=${prerelease}`);
  },
  "bump-version"({ positional }) {
    const version = required(positional[0], "version (e.g. 1.2.3)");
    bumpVersion(version);
    console.error(`Set version ${version} in tauri.conf.json, package.json, package-lock.json, Cargo.toml and Cargo.lock.`);
  },
  "release-notes"({ positional, flags }) {
    const version = required(positional[0], "version");
    const notes = extractReleaseNotes(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version);
    if (flags.out) writeFileSync(flags.out, `${notes}\n`);
    else console.log(notes);
  },
  "verify-signature"({ positional }) {
    const file = required(positional[0], "file to verify");
    const sigFile = positional[1] ?? `${file}.sig`;
    const result = verifyUpdaterSignature({
      data: readFileSync(file),
      signature: readFileSync(sigFile, "utf8"),
      pubkey: readUpdaterPublicKey(),
    });
    console.error(`OK: ${file} is signed by updater key ${result.keyId}.`);
  },
  "check-secrets"() {
    const problems = checkReleaseSecrets(process.env);
    if (problems.length) {
      throw new Error(`${problems.join("\n")}\nSee RELEASE.md → Secrets. Nothing was built or published.`);
    }
    console.error("All release secrets are configured.");
  },
  "check-release-files"({ flags }) {
    const version = required(flags.version, "--version");
    const dir = required(flags.dir, "--dir");
    const platforms = flags.platforms ? parsePlatforms(flags.platforms) : RELEASE_PLATFORMS;
    const problems = checkReleaseFiles({ dir, version, platforms, final: flags.final === true });
    if (problems.length) {
      throw new Error(`${dir} is not a complete ${version} release for ${platforms.join(", ")}:\n  ${problems.join("\n  ")}`);
    }
    console.error(`${dir}: complete ${version} release for ${platforms.join(", ")}${flags.final ? " (final)" : ""}.`);
  },
  "latest-json"({ flags }) {
    const manifest = buildLatestJson({
      version: required(flags.version, "--version"),
      repo: required(flags.repo, "--repo"),
      assetsDir: required(flags["assets-dir"], "--assets-dir"),
      notes: readFileSync(required(flags["notes-file"], "--notes-file"), "utf8").trim(),
      pubkey: readUpdaterPublicKey(),
      platforms: flags.platforms ? parsePlatforms(flags.platforms) : RELEASE_PLATFORMS,
    });
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (flags.out) writeFileSync(flags.out, json);
    else process.stdout.write(json);
    console.error(`latest.json for ${manifest.version}: ${Object.keys(manifest.platforms).join(", ")}`);
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const run = Object.hasOwn(COMMANDS, command ?? "") ? COMMANDS[command] : undefined;
    if (!run) throw new Error(`Usage: release-tools.mjs <${Object.keys(COMMANDS).join("|")}> …`);
    run(parseArgs(rest));
  } catch (err) {
    console.error(`release-tools: ${err.message}`);
    process.exit(1);
  }
}
