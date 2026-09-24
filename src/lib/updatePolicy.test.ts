import { describe, expect, it } from "vitest";
import {
  UPDATE_REMIND_LATER_MS,
  compareVersions,
  createReminder,
  isNewerStableVersion,
  parseReminder,
  parseVersion,
  shouldShowUpdateAlert,
} from "./updatePolicy";

describe("parseVersion", () => {
  it("accepts SemVer with an optional leading v", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: "1", minor: "2", patch: "3", prerelease: [] });
    expect(parseVersion("v0.10.0-beta.2+build.7")).toEqual({
      major: "0",
      minor: "10",
      patch: "0",
      prerelease: ["beta", "2"],
    });
  });

  it("rejects anything that is not SemVer", () => {
    for (const bad of ["", "1.2", "1.2.3.4", "01.2.3", "1.2.3-", "1.2.3-01", "latest", "v"]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
  });

  it("follows the SemVer pre-release precedence example", () => {
    // Straight from semver.org §11.
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i], ordered[i + 1]), `${ordered[i]} < ${ordered[i + 1]}`).toBe(-1);
      expect(compareVersions(ordered[i + 1], ordered[i])).toBe(1);
    }
  });

  it("ignores build metadata and the v prefix", () => {
    expect(compareVersions("1.2.3+build.9", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("throws on invalid input", () => {
    expect(() => compareVersions("1.2", "1.2.3")).toThrow(/Invalid version/);
  });
});

describe("isNewerStableVersion", () => {
  it("offers newer stable releases only", () => {
    expect(isNewerStableVersion("0.2.0", "0.1.0")).toBe(true);
    expect(isNewerStableVersion("0.1.1", "0.1.0")).toBe(true);
    expect(isNewerStableVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerStableVersion("0.0.9", "0.1.0")).toBe(false);
  });

  it("never offers a pre-release", () => {
    expect(isNewerStableVersion("0.2.0-beta.1", "0.1.0")).toBe(false);
    expect(isNewerStableVersion("1.0.0-rc.1", "0.9.0")).toBe(false);
  });

  it("moves a pre-release install to its stable release", () => {
    expect(isNewerStableVersion("0.2.0", "0.2.0-beta.1")).toBe(true);
  });

  it("treats unparsable versions as not newer", () => {
    expect(isNewerStableVersion("garbage", "0.1.0")).toBe(false);
    expect(isNewerStableVersion("0.2.0", "unknown")).toBe(false);
  });
});

describe("Remind Me Later", () => {
  const now = 1_700_000_000_000;

  it("creates a reminder one snooze period out", () => {
    expect(createReminder("0.2.0", now)).toEqual({
      version: "0.2.0",
      remindAt: now + UPDATE_REMIND_LATER_MS,
    });
  });

  it("shows the alert when nothing was snoozed", () => {
    expect(shouldShowUpdateAlert({ version: "0.2.0", reminder: null, now, manual: false })).toBe(true);
  });

  it("hides a snoozed version until its reminder time", () => {
    const reminder = createReminder("0.2.0", now);
    const at = (t: number) =>
      shouldShowUpdateAlert({ version: "0.2.0", reminder, now: t, manual: false });
    expect(at(now + 1)).toBe(false);
    expect(at(reminder.remindAt - 1)).toBe(false);
    expect(at(reminder.remindAt)).toBe(true);
  });

  it("matches the snoozed version by SemVer, not by string", () => {
    const reminder = createReminder("v0.2.0", now);
    expect(shouldShowUpdateAlert({ version: "0.2.0", reminder, now, manual: false })).toBe(false);
  });

  it("shows a different (e.g. newer) version immediately", () => {
    const reminder = createReminder("0.2.0", now);
    expect(shouldShowUpdateAlert({ version: "0.3.0", reminder, now, manual: false })).toBe(true);
  });

  it("always answers a manual check", () => {
    const reminder = createReminder("0.2.0", now);
    expect(shouldShowUpdateAlert({ version: "0.2.0", reminder, now, manual: true })).toBe(true);
  });

  it("does not let a clock change hide an update indefinitely", () => {
    // The clock jumped back a week after snoozing.
    const reminder = createReminder("0.2.0", now);
    const weekEarlier = now - 7 * 24 * 60 * 60 * 1000;
    expect(
      shouldShowUpdateAlert({ version: "0.2.0", reminder, now: weekEarlier, manual: false })
    ).toBe(true);
  });

  it("reads stored reminders defensively", () => {
    expect(parseReminder(null)).toBeNull();
    expect(parseReminder("not json")).toBeNull();
    expect(parseReminder("[]")).toBeNull();
    expect(parseReminder('{"version":"0.2.0"}')).toBeNull();
    expect(parseReminder('{"version":"","remindAt":1}')).toBeNull();
    expect(parseReminder('{"version":"0.2.0","remindAt":"soon"}')).toBeNull();
    expect(parseReminder('{"version":"0.2.0","remindAt":5}')).toEqual({ version: "0.2.0", remindAt: 5 });
  });
});
