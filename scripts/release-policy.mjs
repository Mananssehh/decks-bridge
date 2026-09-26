#!/usr/bin/env node
// Release policy for .github/workflows/release.yml and the scripts it runs.
// scripts/release-policy.test.mjs checks this repository against it (so it runs
// with `npm test`) and shows that it rejects each way a release could reach
// users by accident, unsigned or unnotarized:
//
//   - the workflow runs only for strict version tags and manual dry runs,
//     never for a branch push, and only a tag push can publish;
//   - publishing is draft-first and never replaces a published release;
//   - every required secret is checked before anything is built, and no
//     `if:` reads `secrets` (GitHub does not allow it);
//   - builds go only through the Developer ID + notarization pipeline, for
//     Apple Silicon and Intel, with no self-signed, ad-hoc or internal steps;
//   - the release is macOS only, and latest.json is written from verified
//     signatures after the complete artifact set is checked;
//   - the token is read-only except in the publish job, and checkouts do not
//     persist credentials.
//
//   node scripts/release-policy.mjs      # prints any violations, exits 1 if there are some

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { RELEASE_SECRET_NAMES, ROOT } from "./release-tools.mjs";

export const TAG_PATTERNS = Object.freeze(["v[0-9]+.[0-9]+.[0-9]+", "v[0-9]+.[0-9]+.[0-9]+-*"]);
export const MAC_TARGETS = Object.freeze(["aarch64-apple-darwin", "x86_64-apple-darwin"]);
export const RELEASE_JOBS = Object.freeze(["prepare", "verify", "build-macos", "publish"]);

/** Anything that would put a non-public build, or an ungated upload, into a release. */
const FORBIDDEN = [
  [/build-internal/, "runs an internal build (scripts/build-internal*)"],
  [
    /sign-macos-beta|create-beta-signing-cert|import-beta-identity|MACOS_BETA_SIGNING|Beta Signing/,
    "uses the self-signed beta identity",
  ],
  [/sign-macos-app-adhoc|codesign\b[^\n]*--sign\s+(["']?)-\1(\s|$)/, "signs ad hoc"],
  [/release-macos\.sh/, "runs the removed self-signed release script (scripts/release-macos.sh)"],
  [/release\/internal/, "touches internal build output (release/internal)"],
  [
    /softprops\/action-gh-release|actions\/create-release|ncipollo\/release-action|marvinpinto\/action-automatic-releases/,
    "uses a third-party release action instead of the gated publish steps",
  ],
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const text = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

/** Every string in the workflow with where it is, for pattern checks. */
function strings(node, path = "") {
  if (typeof node === "string") return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((item, i) => strings(item, `${path}[${i}]`));
  if (isObject(node)) {
    return Object.entries(node).flatMap(([key, value]) => [
      [`${path}.${key}#key`, key],
      ...strings(value, path ? `${path}.${key}` : key),
    ]);
  }
  return [];
}

const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);
// Line continuations joined, so a command split over lines reads as one line.
const runOf = (step) => (typeof step?.run === "string" ? step.run.replace(/\\\n\s*/g, " ") : "");
const stepName = (step, i) => step?.name ?? step?.uses ?? (runOf(step).split("\n")[0] || `step ${i + 1}`);

/** What a step does, as text: the action it uses, its upload/download path, its script. */
const stepDoc = (step) => [`uses: ${step?.uses ?? ""}`, `path: ${step?.with?.path ?? ""}`, runOf(step)].join("\n");

/**
 * Checks that each entry happens, in this order, across the job's steps and
 * within a step's script. `order` holds [description, pattern, stepCondition?]:
 * the pattern locates the command in stepDoc(); the optional condition must
 * also hold for the step it is found in.
 */
function checkOrder(job, jobId, order, add) {
  const steps = stepsOf(job);
  const docs = steps.map(stepDoc);
  let cursor = { step: 0, offset: 0 };
  let previousWhat = "the start of the job";
  for (const [what, pattern, condition = () => true] of order) {
    let found = null;
    for (let i = cursor.step; i < docs.length && !found; i++) {
      if (!condition(steps[i])) continue;
      const re = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
      re.lastIndex = i === cursor.step ? cursor.offset : 0;
      const match = re.exec(docs[i]);
      if (match) found = { step: i, offset: match.index + match[0].length };
    }
    if (!found) {
      const anywhere = docs.some((doc, i) => pattern.test(doc) && condition(steps[i]));
      add(anywhere ? `${jobId}: "${what}" must come after "${previousWhat}".` : `${jobId}: missing step: ${what}.`);
      continue;
    }
    // A gate that can be skipped is not a gate.
    if (steps[found.step].if !== undefined) {
      add(`${jobId}: the step for "${what}" must not be conditional (if: ${text(steps[found.step].if)}).`);
    }
    cursor = found;
    previousWhat = what;
  }
}

function needsOf(job) {
  return asList(job?.needs);
}

/** Checks the parsed release workflow. Returns the violations found. */
export function checkWorkflowPolicy(workflow) {
  const problems = [];
  const add = (message) => problems.push(message);
  if (!isObject(workflow)) return ["release.yml is empty or not a mapping."];

  // ── Triggers: version tags and manual dry runs only ────────────────────────
  const on = workflow.on;
  if (!isObject(on)) {
    add(`on: ${text(on)} runs the release for every push to any branch; allow push.tags and workflow_dispatch only.`);
  } else {
    for (const event of Object.keys(on)) {
      if (event !== "push" && event !== "workflow_dispatch") {
        add(`Trigger "${event}" is not allowed: the release runs only for version tags and manual dry runs.`);
      }
    }
    if (!isObject(on.push)) {
      add("on.push.tags is missing: a version tag push is the only way to publish.");
    } else {
      for (const key of Object.keys(on.push)) {
        if (key !== "tags") add(`on.push.${key} is not allowed: a branch push must never run the release.`);
      }
      const tags = asList(on.push.tags);
      if (!tags.length) add("on.push.tags must list the version tag patterns.");
      for (const tag of tags) {
        if (!TAG_PATTERNS.includes(tag)) add(`Tag pattern "${tag}" is not allowed; use ${TAG_PATTERNS.join(" and ")}.`);
      }
    }
  }

  // ── Token permissions ──────────────────────────────────────────────────────
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) {
    add(`Top-level permissions must be exactly { contents: read }, not ${text(workflow.permissions)}.`);
  }

  const jobs = isObject(workflow.jobs) ? workflow.jobs : {};
  for (const id of RELEASE_JOBS) if (!isObject(jobs[id])) add(`Job "${id}" is missing.`);

  for (const [id, job] of Object.entries(jobs)) {
    if (id === "publish") {
      if (JSON.stringify(job.permissions) !== JSON.stringify({ contents: "write" })) {
        add(`publish: permissions must be exactly { contents: write }, not ${text(job.permissions)}.`);
      }
    } else if (job.permissions !== undefined && /write/.test(text(job.permissions))) {
      add(`${id}: only the publish job may have write permissions.`);
    }
    if (!RELEASE_JOBS.includes(id)) add(`Unexpected job "${id}": the release workflow has only ${RELEASE_JOBS.join(", ")}.`);
    if (/windows/i.test(text(job["runs-on"]))) {
      add(`${id}: runs on Windows. The initial release is macOS only (RELEASE.md → "Enabling Windows releases later").`);
    }
    if (/\bsecrets\b/.test(text(job.if))) add(`${id}: "if:" reads secrets, which GitHub does not allow.`);

    stepsOf(job).forEach((step, i) => {
      const where = `${id} → ${stepName(step, i)}`;
      if (/\bsecrets\b/.test(text(step.if))) add(`${where}: "if:" reads secrets, which GitHub does not allow.`);
      if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        if (step.with?.["persist-credentials"] !== false) add(`${where}: checkout must set persist-credentials: false.`);
      }
      if (id !== "publish" && /\bgh\s+release\b/.test(runOf(step))) {
        add(`${where}: only the publish job may touch GitHub Releases.`);
      }
      if (step.env && Object.hasOwn(step.env, "APPLE_API_KEY_PATH")) {
        add(`${where}: APPLE_API_KEY_PATH must come from the step that writes the key (via GITHUB_ENV), not from env:.`);
      }
      if (step.env && Object.hasOwn(step.env, "APPLE_API_KEY") && !/check-secrets/.test(runOf(step)) && !/AuthKey\.p8/.test(runOf(step))) {
        add(`${where}: APPLE_API_KEY (the key file) is only for check-secrets and the step that writes it.`);
      }
    });
  }

  for (const [path, value] of strings(workflow)) {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(value)) add(`${path}: ${why}.`);
    }
  }

  // ── Secrets: every referenced secret is known; all are checked up front ────
  for (const [path, value] of strings(workflow)) {
    for (const match of value.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!RELEASE_SECRET_NAMES.includes(match[1])) add(`${path}: unknown secret ${match[1]}.`);
    }
  }

  const { prepare, verify, publish } = jobs;
  const build = jobs["build-macos"];

  if (prepare) {
    const secretsStep = stepsOf(prepare).find((step) => /release-tools\.mjs check-secrets\b/.test(runOf(step)));
    if (!secretsStep) {
      add("prepare: missing the check-secrets step, so a missing secret would only fail mid-build.");
    } else {
      for (const name of RELEASE_SECRET_NAMES) {
        if (secretsStep.env?.[name] !== `\${{ secrets.${name} }}`) {
          add(`prepare → check-secrets: ${name} is not passed in as \${{ secrets.${name} }}.`);
        }
      }
    }
    checkOrder(
      prepare,
      "prepare",
      [
        ["version check", /release-tools\.mjs check-version\b/],
        ["release notes from CHANGELOG.md", /release-tools\.mjs release-notes\b/],
        ["secrets check", /release-tools\.mjs check-secrets\b/],
        ["updater key check", /tauri signer sign[\s\S]*release-tools\.mjs verify-signature/],
      ],
      add
    );
    const mainCheck = stepsOf(prepare).find((step) => /merge-base --is-ancestor/.test(runOf(step)));
    if (!mainCheck || !/prerelease == 'false'/.test(text(mainCheck.if))) {
      add("prepare: stable tags must be checked to be on main (merge-base --is-ancestor for non-pre-releases).");
    }
  }

  if (verify) {
    if (!needsOf(verify).includes("prepare")) add("verify: must need prepare, so nothing builds before the secrets check.");
    checkOrder(
      verify,
      "verify",
      [
        ["typecheck", /npm run typecheck/],
        ["lint", /npm run lint/],
        ["tests", /npm test\b/],
        ["frontend build", /npm run build\b/],
        ["Rust tests", /cargo test/],
      ],
      add
    );
  }

  if (build) {
    for (const need of ["prepare", "verify"]) {
      if (!needsOf(build).includes(need)) add(`build-macos: must need ${need}.`);
    }
    if (!/^macos-/.test(text(build["runs-on"]))) add("build-macos: must run on a macOS runner.");
    const targets = asList(build.strategy?.matrix?.include).map((entry) => entry?.target);
    if (JSON.stringify([...targets].sort()) !== JSON.stringify([...MAC_TARGETS].sort())) {
      add(`build-macos: the matrix must build exactly ${MAC_TARGETS.join(" and ")}, not ${text(targets)}.`);
    }
    checkOrder(
      build,
      "build-macos",
      [
        ["Gatekeeper assessments enabled", /spctl --status/],
        [
          "Developer ID certificate import",
          /security import/,
          (s) => /find-identity[^\n]*\|\s*grep -q '"Developer ID Application: '/.test(runOf(s)),
        ],
        [
          "App Store Connect key written to an expanded path",
          /"\$RUNNER_TEMP\/AuthKey\.p8"/,
          (s) => /APPLE_API_KEY_PATH=\$key_path" >> "\$GITHUB_ENV"/.test(runOf(s)),
        ],
        ["production build (scripts/build-release.sh)", /bash scripts\/build-release\.sh "\$TARGET"/],
        ["artifact set check for this architecture", /check-release-files\b[^\n]*--platforms/],
        [
          "upload of release/v<version>/mac only",
          /^path: release\/v\$\{\{[^}]+\}\}\/mac\/?$/m,
          (s) => /^actions\/upload-artifact@/.test(s.uses ?? ""),
        ],
      ],
      add
    );
    const cleanup = stepsOf(build).find((step) => /security delete-keychain/.test(runOf(step)));
    if (!cleanup || cleanup.if !== "always()") add("build-macos: the signing keychain must be removed in an always() step.");
  }

  if (publish) {
    const guard = text(publish.if);
    if (!/github\.event_name == 'push'/.test(guard) || !/github\.ref_type == 'tag'/.test(guard)) {
      add("publish: must run only for tag pushes (if: github.event_name == 'push' && github.ref_type == 'tag').");
    }
    for (const need of ["prepare", "verify", "build-macos"]) {
      if (!needsOf(publish).includes(need)) add(`publish: must need ${need}.`);
    }
    checkOrder(
      publish,
      "publish",
      [
        ["download of the verified build artifacts", /^uses: actions\/download-artifact@/m],
        ["complete artifact set check", /check-release-files\b(?![^\n]*--final)/],
        ["latest.json from verified signatures", /release-tools\.mjs latest-json\b/],
        ["final file set check", /check-release-files\b[^\n]*--final/],
        [
          "draft release that refuses to replace a published one",
          /isDraft[\s\S]*already published[\s\S]*exit 1[\s\S]*gh release create\b/,
          (s) => /--draft\b/.test(runOf(s)),
        ],
        ["publish of the draft", /gh release edit\b[^\n]*--draft=false/],
      ],
      add
    );
    for (const step of stepsOf(publish)) {
      if (/(latest-json|check-release-files)\b[^\n]*--platforms[^\n]*windows/.test(runOf(step))) {
        add("publish: Windows is not part of the initial release.");
      }
      if (/gh release create\b/.test(runOf(step)) && !/--draft\b/.test(runOf(step))) {
        add("publish: releases must be created as drafts and published only after every upload.");
      }
    }
  }

  return [...new Set(problems)];
}

/** Script text with full-line comments removed, so comments cannot satisfy a rule. */
const code = (source) =>
  (source ?? "")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** Checks the production gates inside the scripts the workflow runs. */
export function checkScriptPolicy(scripts) {
  const problems = [];
  const add = (message) => problems.push(message);
  const inOrder = (file, steps, source = code(scripts[file])) => {
    const body = source;
    if (!body) return add(`${file} is missing.`);
    let from = 0;
    for (const [what, pattern] of steps) {
      const rest = body.slice(from);
      const match = pattern.exec(rest);
      if (!match) {
        add(pattern.test(body) ? `${file}: ${what} is out of order.` : `${file}: missing ${what}.`);
        continue;
      }
      from += match.index + match[0].length;
    }
  };

  inOrder("scripts/build-release.sh", [
    ["the signing preflight", /bash "\$ROOT\/scripts\/preflight-signing\.sh"/],
    ["the Tauri build", /npx tauri build --bundles app/],
    ["Developer ID signing", /bash "\$ROOT\/scripts\/sign-macos-app\.sh" "\$APP"/],
    ["notarization and stapling", /bash "\$ROOT\/scripts\/notarize-macos-app\.sh" "\$APP"/],
    ["packaging", /bash "\$ROOT\/scripts\/package-artifacts\.sh" "\$TARGET"/],
    ["verification of the requested target", /bash "\$ROOT\/scripts\/verify-release\.sh" "\$APP" "\$TARGET"/],
  ]);
  inOrder("scripts/package-artifacts.sh", [
    ["the architecture check", /ARCH_TAG="\$\(resolve_arch_tag "\$TARGET" "\$APP_PATH"\)"/],
    ["the public-distribution check before packaging", /check_public_app "\$APP_PATH" "\$VERSION" "\$ARCH_TAG"/],
    ["the DMG", /create_dmg_from_app "\$APP_PATH" "\$DMG_PATH"/],
    ["Developer ID signing of the DMG", /sign_dmg "\$DMG_PATH"/],
    ["notarization of the DMG", /notarize-macos-app\.sh" "\$DMG_PATH"/],
    ["the updater tarball", /create_updater_tarball "\$APP_PATH" "\$TAR_PATH"/],
    ["updater signing", /sign_updater_tarball "\$TAR_PATH"/],
  ]);
  inOrder("scripts/verify-release.sh", [
    ["the architecture check", /resolve_arch_tag "\$TARGET" "\$APP"/],
    ["the built app check", /check_public_app "\$APP"/],
    ["the DMG check", /check_public_dmg "\$DMG"/],
    ["the app-in-DMG check", /check_public_app "\$MNT\/\$APP_BUNDLE_NAME"/],
    ["the app-in-ZIP check", /check_public_app "\$WORK\/zip\/\$APP_BUNDLE_NAME"/],
    ["the app-in-tarball check", /check_public_app "\$WORK\/tar\/\$APP_BUNDLE_NAME"/],
    ["updater signature verification", /release-tools\.mjs" verify-signature/],
  ]);
  const common = code(scripts["scripts/release-common.sh"]);
  const inFunction = (name, steps) => {
    const body = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(common)?.[1];
    if (!body) return add(`scripts/release-common.sh: missing ${name}().`);
    inOrder(`scripts/release-common.sh ${name}()`, steps, body);
  };
  inFunction("check_public_app", [
    ["the signature check", /! codesign --verify --deep --strict "\$app"/],
    ["the Developer ID check", /! grep -q '\^Authority=Developer ID Application: ' <<<"\$info"/],
    ["the ad-hoc check", /grep -q '\^Signature=adhoc' <<<"\$info"/],
    ["the hardened runtime check", /runtime' <<<"\$info"/],
    ["the stapled ticket check", /! xcrun stapler validate "\$app"/],
    ["the Gatekeeper check", /spctl -a -vvv -t exec "\$app"/],
    ["the Gatekeeper-disabled check", /grep -q 'override=security disabled' <<<"\$spctl_out"/],
    ["the notarized source check", /! grep -qx 'source=Notarized Developer ID' <<<"\$spctl_out"/],
    ["the version check", /"\$short_version" != "\$version"/],
    ["the architecture check", /"\$archs" != "\$want_arch"/],
  ]);
  inFunction("check_public_dmg", [
    ["the signature check", /! codesign --verify --strict "\$dmg"/],
    ["the Developer ID check", /! grep -q '\^Authority=Developer ID Application: ' <<<"\$info"/],
    ["the stapled ticket check", /! xcrun stapler validate "\$dmg"/],
    ["the Gatekeeper check", /spctl -a -vvv -t open --context context:primary-signature "\$dmg"/],
    ["the Gatekeeper-disabled check", /grep -q 'override=security disabled' <<<"\$spctl_out"/],
    ["the notarized source check", /! grep -qx 'source=Notarized Developer ID' <<<"\$spctl_out"/],
  ]);
  if (!/sign_updater_tarball[\s\S]*release-tools\.mjs" verify-signature/.test(code(scripts["scripts/package-artifacts.sh"]))) {
    add("scripts/package-artifacts.sh: the updater signature must be verified right after signing.");
  }

  for (const file of ["scripts/package-artifacts.sh", "scripts/verify-release.sh", "scripts/release-common.sh"]) {
    if (/uname -m/.test(code(scripts[file]))) add(`${file}: architecture must not come from the build machine (uname -m).`);
  }
  for (const [file, source] of Object.entries(scripts)) {
    if (/(^|[\s|;&(])rg\s/m.test(code(source))) add(`${file}: uses rg, which macOS runners do not have; use grep.`);
  }
  return problems;
}

/** A workflow other than release.yml must never publish a GitHub Release. */
export function checkOtherWorkflow(name, source) {
  const body = code(source);
  return /\bgh\s+release\s+(create|upload|edit)\b|action-gh-release|actions\/create-release|release-action|\/releases\b/.test(body)
    ? [`${name}: only release.yml may publish GitHub Releases.`]
    : [];
}

/** Scripts the release workflow depends on, relative to the repository root. */
export const RELEASE_SCRIPTS = Object.freeze([
  "scripts/build-release.sh",
  "scripts/preflight-signing.sh",
  "scripts/sign-macos-app.sh",
  "scripts/notarize-macos-app.sh",
  "scripts/package-artifacts.sh",
  "scripts/verify-release.sh",
  "scripts/release-common.sh",
]);

export function loadReleaseFiles(root = ROOT) {
  const workflowsDir = join(root, ".github/workflows");
  const workflows = Object.fromEntries(
    readdirSync(workflowsDir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(join(workflowsDir, name), "utf8")])
  );
  const scripts = Object.fromEntries(RELEASE_SCRIPTS.map((file) => [file, readFileSync(join(root, file), "utf8")]));
  return { workflows, scripts };
}

/** Checks this repository: release.yml, the other workflows and the release scripts. */
export function checkReleasePolicy({ workflows, scripts } = loadReleaseFiles()) {
  const problems = [];
  const release = workflows["release.yml"];
  if (!release) problems.push(".github/workflows/release.yml is missing.");
  else problems.push(...checkWorkflowPolicy(yaml.load(release)));
  for (const [name, source] of Object.entries(workflows)) {
    if (name !== "release.yml") problems.push(...checkOtherWorkflow(name, source));
  }
  problems.push(...checkScriptPolicy(scripts));
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = checkReleasePolicy();
  if (problems.length) {
    console.error(`Release policy violations:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.error("Release policy: OK");
}
