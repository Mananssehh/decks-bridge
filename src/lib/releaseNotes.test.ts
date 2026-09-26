import { describe, expect, it } from "vitest";
import { formatReleaseNotes } from "./releaseNotes";

describe("formatReleaseNotes", () => {
  it("turns a CHANGELOG section into plain text", () => {
    const markdown = [
      "### Added",
      "- **Update alerts** with `Remind Me Later`",
      "* See [the guide](https://example.com/guide)",
      "",
      "",
      "",
      "### Fixed",
      "  - Nested item",
    ].join("\n");

    expect(formatReleaseNotes(markdown)).toBe(
      [
        "Added",
        "• Update alerts with Remind Me Later",
        "• See the guide",
        "",
        "Fixed",
        "  • Nested item",
      ].join("\n")
    );
  });

  it("leaves plain text alone", () => {
    expect(formatReleaseNotes("Faster djay detection.\nFewer reconnects.")).toBe(
      "Faster djay detection.\nFewer reconnects."
    );
  });

  it("keeps markup characters that are not Markdown syntax", () => {
    expect(formatReleaseNotes("Tips over $5 * 2 now show")).toBe("Tips over $5 * 2 now show");
    expect(formatReleaseNotes("<b>not html</b>")).toBe("<b>not html</b>");
  });
});
