/**
 * Turns Markdown release notes (a CHANGELOG.md section) into readable plain
 * text for the update alert, which never renders HTML.
 */
export function formatReleaseNotes(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "") // headings
        .replace(/^(\s*)[-*+]\s+/, "$1• ") // bullets
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
        .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
        .replace(/`([^`]+)`/g, "$1") // inline code
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
