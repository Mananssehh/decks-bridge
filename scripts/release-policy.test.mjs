// Checks this repository's release workflow and scripts against the release
// policy (scripts/release-policy.mjs), and that the policy catches each kind of
// regression: push-triggered publishing, self-signed or internal release steps,
// missing production gates, `secrets` in `if:`, and incomplete required secrets.
// Each mutation below is one exact edit to the real release.yml or script.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { RELEASE_SECRET_NAMES, ROOT } from "./release-tools.mjs";
import {
  checkOtherWorkflow,
  checkReleasePolicy,
  checkScriptPolicy,
  checkWorkflowPolicy,
  loadReleaseFiles,
} from "./release-policy.mjs";

const FILES = loadReleaseFiles();
const WORKFLOW = FILES.workflows["release.yml"];

/** release.yml with one edit; `from` must occur exactly once so the edit cannot miss. */
function editWorkflow(from, to) {
  expect(WORKFLOW.split(from).length - 1, `"${from}" must occur exactly once in release.yml`).toBe(1);
  return WORKFLOW.replace(from, to);
}
const problemsAfter = (from, to) => checkWorkflowPolicy(yaml.load(editWorkflow(from, to)));

/** The release scripts with one edit to one of them. */
function problemsAfterScriptEdit(file, from, to) {
  const source = FILES.scripts[file];
  expect(source.split(from).length - 1, `"${from}" must occur exactly once in ${file}`).toBe(1);
  return checkScriptPolicy({ ...FILES.scripts, [file]: source.replace(from, to) });
}

const workflowObject = () => yaml.load(WORKFLOW);
const secretsStep = (workflow) =>
  workflow.jobs.prepare.steps.find((step) => /release-tools\.mjs check-secrets/.test(step.run ?? ""));

const ON_BLOCK = `on:
  push:
    tags:
      - "v[0-9]+.[0-9]+.[0-9]+"
      - "v[0-9]+.[0-9]+.[0-9]+-*"
  workflow_dispatch:
`;
const PUBLISH_GUARD = "    if: github.event_name == 'push' && github.ref_type == 'tag'\n";
const BUILD_STEP = `        run: bash scripts/build-release.sh "$TARGET"\n`;
const KEY_STEP_NAME = "      - name: Write the App Store Connect API key\n";

describe("this repository", () => {
  it("passes the release policy", () => {
    expect(checkReleasePolicy()).toEqual([]);
  });

  it("checks every secret the release uses before anything is built", () => {
    const step = secretsStep(workflowObject());
    expect(Object.keys(step.env).sort()).toEqual([...RELEASE_SECRET_NAMES].sort());
  });
});

describe("push-triggered publishing is rejected", () => {
  it.each([
    [
      "a branch push trigger",
      '    tags:\n      - "v[0-9]+.[0-9]+.[0-9]+"\n',
      '    branches: [main]\n    tags:\n      - "v[0-9]+.[0-9]+.[0-9]+"\n',
      /on\.push\.branches is not allowed/,
    ],
    ["every push", ON_BLOCK, "on: [push, workflow_dispatch]\n", /runs the release for every push/],
    ["a pull_request trigger", "  workflow_dispatch:\n", "  workflow_dispatch:\n  pull_request:\n", /Trigger "pull_request" is not allowed/],
    ["a schedule", "  workflow_dispatch:\n", "  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * 1'\n", /Trigger "schedule" is not allowed/],
    ["a catch-all tag pattern", '      - "v[0-9]+.[0-9]+.[0-9]+-*"', '      - "v*"', /Tag pattern "v\*" is not allowed/],
    [
      "publishing from a manual run on a tag",
      PUBLISH_GUARD,
      "    if: github.ref_type == 'tag'\n",
      /publish: must run only for tag pushes/,
    ],
    ["a publish job without a guard", PUBLISH_GUARD, "", /publish: must run only for tag pushes/],
  ])("%s", (_name, from, to, problem) => {
    expect(problemsAfter(from, to)).toContainEqual(expect.stringMatching(problem));
  });
});

describe("self-signed, ad-hoc and internal release steps are rejected", () => {
  it.each([
    [
      "an internal build instead of the production build",
      BUILD_STEP,
      `        run: bash scripts/build-internal.sh "$TARGET"\n`,
      [/runs an internal build/, /missing step: production build/],
    ],
    [
      "signing with the beta identity",
      BUILD_STEP,
      `${BUILD_STEP}\n      - run: bash scripts/sign-macos-beta.sh "release/Decks Bridge.app"\n`,
      [/uses the self-signed beta identity/],
    ],
    [
      "ad-hoc signing",
      BUILD_STEP,
      `${BUILD_STEP}\n      - run: codesign --force --deep --sign - "release/Decks Bridge.app"\n`,
      [/signs ad hoc/],
    ],
    [
      "the removed self-signed release script",
      BUILD_STEP,
      `        run: bash scripts/release-macos.sh package "$TARGET"\n`,
      [/removed self-signed release script/],
    ],
    [
      "uploading internal build output",
      "          path: release/v${{ needs.prepare.outputs.version }}/mac/\n",
      "          path: release/internal/mac/\n",
      [/touches internal build output/, /missing step: upload of release\/v<version>\/mac only/],
    ],
    [
      "a third-party release action",
      "      - name: Publish release\n",
      "      - uses: softprops/action-gh-release@v2\n        with:\n          files: release-upload/*\n\n      - name: Publish release\n",
      [/third-party release action/],
    ],
  ])("%s", (_name, from, to, expected) => {
    const problems = problemsAfter(from, to);
    for (const problem of expected) expect(problems).toContainEqual(expect.stringMatching(problem));
  });

  it("rejects both pre-reconciliation workflows", () => {
    const fixture = (name) => checkWorkflowPolicy(yaml.load(readFileSync(join(ROOT, "scripts/fixtures", name), "utf8")));

    const pr1 = fixture("release-pr1-original.yml");
    for (const problem of [
      /Write App Store Connect API key: "if:" reads secrets/,
      /Tag pattern "v\*" is not allowed/,
      /Top-level permissions must be exactly \{ contents: read \}/,
      /third-party release action/,
      /runs on Windows/,
      /APPLE_API_KEY_PATH must come from the step that writes the key/,
      /"Rust tests" must come after "frontend build"/,
      /missing step: latest\.json from verified signatures/,
    ]) {
      expect(pr1).toContainEqual(expect.stringMatching(problem));
    }

    const pr2 = fixture("release-pr2-original.yml");
    for (const problem of [
      /uses the self-signed beta identity/,
      /removed self-signed release script/,
      /unknown secret MACOS_BETA_SIGNING_P12_BASE64/,
      /runs on Windows/,
      /publish: must run only for tag pushes/,
      /missing step: Developer ID certificate import/,
    ]) {
      expect(pr2).toContainEqual(expect.stringMatching(problem));
    }
  });
});

describe("missing production gates are rejected", () => {
  it.each([
    [
      "a gate that can be skipped",
      "      - name: Gatekeeper assessments are enabled\n",
      "      - name: Gatekeeper assessments are enabled\n        if: false\n",
      /the step for "Gatekeeper assessments enabled" must not be conditional/,
    ],
    [
      "no Gatekeeper check on the runner",
      "          if ! spctl --status | grep -q 'assessments enabled'; then\n            sudo spctl --master-enable\n          fi\n          spctl --status | grep -q 'assessments enabled' \\\n            || { echo \"::error::Gatekeeper assessments are disabled on this runner.\"; exit 1; }\n",
      "          echo skipped\n",
      /missing step: Gatekeeper assessments enabled/,
    ],
    [
      "a certificate import that accepts any identity",
      `grep -q '"Developer ID Application: '`,
      `grep -q '"'`,
      /missing step: Developer ID certificate import/,
    ],
    [
      "no per-architecture artifact check",
      `        run: node scripts/release-tools.mjs check-release-files --version "$VERSION" --dir "release/v$VERSION/mac" --platforms "$PLATFORM"\n`,
      "        run: ls release\n",
      /missing step: artifact set check for this architecture/,
    ],
    [
      "no complete-set check before latest.json",
      `          node scripts/release-tools.mjs check-release-files --version "$VERSION" --dir release-upload\n`,
      "",
      /"latest\.json from verified signatures" must come after|missing step: complete artifact set check/,
    ],
    [
      "no latest.json",
      "          node scripts/release-tools.mjs latest-json \\\n",
      "          true \\\n",
      /missing step: latest\.json from verified signatures/,
    ],
    [
      "no final file set check",
      ` --dir release-upload --final\n`,
      ` --dir release-upload\n`,
      /missing step: final file set check/,
    ],
    [
      "creating the release without a draft",
      "          flags=(--draft --verify-tag",
      "          flags=(--verify-tag",
      /missing step: draft release|created as drafts/,
    ],
    [
      "replacing a published release",
      "              exit 1\n            fi\n            echo \"Replacing",
      "            fi\n            echo \"Replacing",
      /missing step: draft release that refuses to replace a published one/,
    ],
    [
      "Rust tests before the frontend build",
      "      - name: Frontend build (includes the mock-data guard)\n        run: npm run build\n\n      # After the frontend build: the Rust crate embeds dist/ at compile time.\n      - name: Rust tests\n        working-directory: src-tauri\n        run: cargo test --bin decks-bridge\n",
      "      - name: Rust tests\n        working-directory: src-tauri\n        run: cargo test --bin decks-bridge\n\n      - name: Frontend build (includes the mock-data guard)\n        run: npm run build\n",
      /"Rust tests" must come after "frontend build"/,
    ],
    ["builds that skip the tests", "    needs: [prepare, verify]\n", "    needs: [prepare]\n", /build-macos: must need verify/],
    [
      "only one architecture",
      "          - target: x86_64-apple-darwin\n            arch: x64\n            platform: darwin-x86_64\n",
      "",
      /the matrix must build exactly aarch64-apple-darwin and x86_64-apple-darwin/,
    ],
    [
      "a Windows build",
      "  publish:\n",
      "  build-windows:\n    runs-on: windows-latest\n    steps:\n      - run: echo windows\n\n  publish:\n",
      /runs on Windows/,
    ],
    [
      "Windows in latest.json",
      "--notes-file artifacts/release-notes/release-notes.md --out release-upload/latest.json",
      "--notes-file artifacts/release-notes/release-notes.md --out release-upload/latest.json --platforms darwin-aarch64,darwin-x86_64,windows-x86_64",
      /Windows is not part of the initial release/,
    ],
    [
      "a keychain left behind on failure",
      "      - name: Remove the signing keychain and API key\n        if: always()\n",
      "      - name: Remove the signing keychain and API key\n",
      /keychain must be removed in an always\(\) step/,
    ],
    [
      "an App Store Connect key path that is never expanded",
      `        run: bash scripts/build-release.sh "$TARGET"`,
      `          APPLE_API_KEY_PATH: ~/.appstoreconnect/private_keys/AuthKey.p8\n        run: bash scripts/build-release.sh "$TARGET"`,
      /APPLE_API_KEY_PATH must come from the step that writes the key/,
    ],
    [
      "an App Store Connect key written to an unexpanded path",
      `key_path="$RUNNER_TEMP/AuthKey.p8"`,
      `key_path="~/.appstoreconnect/private_keys/AuthKey.p8"`,
      /missing step: App Store Connect key written to an expanded path/,
    ],
  ])("%s", (_name, from, to, problem) => {
    expect(problemsAfter(from, to)).toContainEqual(expect.stringMatching(problem));
  });

  it.each([
    [
      "no notarization",
      "scripts/build-release.sh",
      'bash "$ROOT/scripts/notarize-macos-app.sh" "$APP"\n',
      "",
      /missing notarization and stapling/,
    ],
    [
      "notarizing before signing",
      "scripts/build-release.sh",
      'bash "$ROOT/scripts/sign-macos-app.sh" "$APP"\n',
      "",
      /missing Developer ID signing/,
    ],
    [
      "verifying the runner's architecture instead of the target",
      "scripts/build-release.sh",
      'bash "$ROOT/scripts/verify-release.sh" "$APP" "$TARGET"',
      'bash "$ROOT/scripts/verify-release.sh" "$APP"',
      /missing verification of the requested target/,
    ],
    [
      "no signing preflight",
      "scripts/build-release.sh",
      'bash "$ROOT/scripts/preflight-signing.sh"',
      "true",
      /missing the signing preflight/,
    ],
    [
      "packaging before the public-distribution check",
      "scripts/package-artifacts.sh",
      '  if ! check_public_app "$APP_PATH" "$VERSION" "$ARCH_TAG"; then',
      '  if false; then',
      /missing the public-distribution check before packaging/,
    ],
    [
      "an unnotarized DMG",
      "scripts/package-artifacts.sh",
      '  bash "$ROOT/scripts/notarize-macos-app.sh" "$DMG_PATH"\n',
      "",
      /missing notarization of the DMG/,
    ],
    [
      "an unverified updater signature",
      "scripts/package-artifacts.sh",
      '    node "$ROOT/scripts/release-tools.mjs" verify-signature "$tarball" "$sig"\n',
      "",
      /updater signature must be verified right after signing/,
    ],
    [
      "the architecture from the build machine",
      "scripts/package-artifacts.sh",
      '  ARCH_TAG="$(resolve_arch_tag "$TARGET" "$APP_PATH")"',
      '  ARCH_TAG="$(uname -m)"',
      /uname -m/,
    ],
    [
      "no DMG check in verification",
      "scripts/verify-release.sh",
      'check_public_dmg "$DMG" || fail',
      "true || fail",
      /missing the DMG check/,
    ],
    [
      "no updater signature check in verification",
      "scripts/verify-release.sh",
      'node "$ROOT/scripts/release-tools.mjs" verify-signature "$TAR" "$SIG"',
      "true",
      /missing updater signature verification/,
    ],
    [
      "a Gatekeeper check that ignores notarization",
      "scripts/release-common.sh",
      "! grep -qx 'source=Notarized Developer ID' <<<\"$spctl_out\"; then\n    echo \"  ✗ $app",
      "false; then\n    echo \"  ✗ $app",
      /check_public_app\(\): missing the notarized source check/,
    ],
    [
      "a DMG check that ignores the stapled ticket",
      "scripts/release-common.sh",
      'if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then',
      "if false; then",
      /check_public_dmg\(\): missing the stapled ticket check/,
    ],
    [
      "an app check that accepts ad-hoc signatures",
      "scripts/release-common.sh",
      "if grep -q '^Signature=adhoc' <<<\"$info\"; then",
      "if false; then",
      /check_public_app\(\): missing the ad-hoc check/,
    ],
    [
      "ripgrep, which macOS runners do not have",
      "scripts/verify-release.sh",
      "if grep -q 'com.apple.quarantine' <<<\"$XATTRS\"; then",
      "if rg -q 'com.apple.quarantine' <<<\"$XATTRS\"; then",
      /uses rg/,
    ],
  ])("%s", (_name, file, from, to, problem) => {
    expect(problemsAfterScriptEdit(file, from, to)).toContainEqual(expect.stringMatching(problem));
  });
});

describe("secrets in if: are rejected", () => {
  it("on a step", () => {
    expect(
      problemsAfter(KEY_STEP_NAME, `${KEY_STEP_NAME}        if: \${{ secrets.APPLE_API_KEY != '' }}\n`)
    ).toContainEqual(expect.stringMatching(/Write the App Store Connect API key: "if:" reads secrets/));
  });

  it("on a job", () => {
    expect(problemsAfter(PUBLISH_GUARD, "    if: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY != '' }}\n")).toContainEqual(
      expect.stringMatching(/^publish: "if:" reads secrets/)
    );
  });
});

describe("incomplete required secrets are rejected", () => {
  it.each(RELEASE_SECRET_NAMES)("%s missing from the secrets check", (name) => {
    const workflow = workflowObject();
    delete secretsStep(workflow).env[name];
    expect(checkWorkflowPolicy(workflow)).toContainEqual(
      `prepare → check-secrets: ${name} is not passed in as \${{ secrets.${name} }}.`
    );
  });

  it("a secret mapped from the wrong name", () => {
    const workflow = workflowObject();
    secretsStep(workflow).env.APPLE_ID = "${{ secrets.APPLE_ID_OLD }}";
    const problems = checkWorkflowPolicy(workflow);
    expect(problems).toContainEqual(expect.stringMatching(/APPLE_ID is not passed in as/));
    expect(problems).toContainEqual(expect.stringMatching(/unknown secret APPLE_ID_OLD/));
  });

  it("no secrets check at all", () => {
    const workflow = workflowObject();
    workflow.jobs.prepare.steps = workflow.jobs.prepare.steps.filter((step) => step !== secretsStep(workflow));
    expect(checkWorkflowPolicy(workflow)).toContainEqual(expect.stringMatching(/missing the check-secrets step/));
  });

  it("builds that do not wait for the secrets check", () => {
    expect(problemsAfter("    needs: prepare\n", "")).toContainEqual(
      expect.stringMatching(/verify: must need prepare/)
    );
  });
});

describe("least privilege", () => {
  it.each([
    ["a writable token for every job", "permissions:\n  contents: read\n", "permissions:\n  contents: write\n", /Top-level permissions/],
    [
      "write access outside the publish job",
      "    name: Tests and build checks\n",
      "    name: Tests and build checks\n    permissions:\n      contents: write\n",
      /verify: only the publish job may have write permissions/,
    ],
    [
      "persisted checkout credentials",
      "      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n",
      "      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n",
      /checkout must set persist-credentials: false/,
    ],
    [
      "GitHub Releases touched outside the publish job",
      `        run: bash scripts/build-release.sh "$TARGET"`,
      `        run: bash scripts/build-release.sh "$TARGET" && gh release upload "$VERSION" release/*`,
      /only the publish job may touch GitHub Releases/,
    ],
  ])("rejects %s", (_name, from, to, problem) => {
    expect(problemsAfter(from, to)).toContainEqual(expect.stringMatching(problem));
  });

  it("keeps every other workflow from publishing releases", () => {
    for (const [name, source] of Object.entries(FILES.workflows)) {
      if (name !== "release.yml") expect(checkOtherWorkflow(name, source)).toEqual([]);
    }
    expect(checkOtherWorkflow("beta.yml", "jobs:\n  b:\n    steps:\n      - run: gh release create v0.0.1 x.dmg\n")).toEqual([
      "beta.yml: only release.yml may publish GitHub Releases.",
    ]);
    expect(checkOtherWorkflow("beta.yml", "jobs:\n  b:\n    steps:\n      - uses: softprops/action-gh-release@v2\n")).toHaveLength(1);
  });
});
