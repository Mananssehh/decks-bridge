import { openViewer } from "../../lib/windows";

/**
 * Entry point into the Live Event Console. Rendered INLINE inside the main
 * window's connection strip — it used to be a fixed floating pill that covered
 * the content beneath it.
 */
export default function ConsoleLauncher() {
  return (
    <button
      type="button"
      className="bx-btn-primary"
      onClick={() => openViewer("expanded").catch((e) => console.error("[launcher]", e))}
      title="Open the Live Event Console"
    >
      <span aria-hidden>\uD83C\uDF9B\uFE0F</span> Open Live Console
    </button>
  );
}
