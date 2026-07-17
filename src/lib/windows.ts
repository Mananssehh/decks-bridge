// ── Viewer window manager ────────────────────────────────────────────────────
//
// Creates the three viewer surfaces as SEPARATE Tauri windows, each loading the
// single Vite entry with a distinguishing hash so no build changes are needed:
//
//   expanded → index.html#viewer/expanded   (normal decorated window)
//   mini     → index.html#viewer/mini        (small, always-on-top, no chrome)
//   pill     → index.html#viewer/pill         (tiny, always-on-top, draggable)
//
// SINGLE-VIEWER INVARIANT: only one viewer surface is alive at a time. Switching
// modes creates/focuses the target and CLOSES (destroys) the previous webview —
// they are never all kept alive together. The existing `main` window is never
// touched here; it keeps its exact role (pairing + Now Playing sender).
//
// Window geometry (position/size) and the always-on-top preference are persisted
// so the viewer reopens where the DJ left it. All calls are best-effort and
// swallow errors: a failed window op must never crash the app or disturb
// detection / heartbeat / sync.

import type { WebviewWindow as TWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ViewerMode } from "./bridge/types";
import { getAlwaysOnTopPref } from "./viewerSettings";

// The Tauri window API is imported lazily (inside the functions that need it) so
// this module can be pulled into the graph — and `viewerModeFromHash` called —
// in any context, including a plain browser preview, without eagerly loading
// native bindings that only resolve inside the Tauri runtime.
async function tauriWebviewWindow(): Promise<typeof TWebviewWindow> {
  const mod = await import("@tauri-apps/api/webviewWindow");
  return mod.WebviewWindow;
}

const LABELS: Record<ViewerMode, string> = {
  expanded: "viewer-expanded",
  mini: "viewer-mini",
  pill: "viewer-pill",
};

type WindowSpec = {
  label: string;
  hash: string;
  title: string;
  width: number;
  height: number;
  resizable: boolean;
  decorations: boolean;
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  minWidth?: number;
  minHeight?: number;
};

const SPECS: Record<ViewerMode, WindowSpec> = {
  expanded: {
    label: LABELS.expanded,
    hash: "#viewer/expanded",
    title: "Decks — Live Event Console",
    width: 960,
    height: 640,
    resizable: true,
    decorations: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    minWidth: 720,
    minHeight: 520,
  },
  mini: {
    label: LABELS.mini,
    hash: "#viewer/mini",
    title: "Decks — Mini Player",
    width: 340,
    height: 132,
    resizable: false,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
  },
  pill: {
    label: LABELS.pill,
    hash: "#viewer/pill",
    title: "Decks — Pill",
    width: 300,
    height: 64,
    resizable: false,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
  },
};

/** Parse the current window's hash into a viewer mode, or null for the main app. */
export function viewerModeFromHash(): ViewerMode | null {
  const h = window.location.hash.toLowerCase();
  if (h.startsWith("#viewer/expanded")) return "expanded";
  if (h.startsWith("#viewer/mini")) return "mini";
  if (h.startsWith("#viewer/pill")) return "pill";
  return null;
}

function specUrl(spec: WindowSpec): string {
  // Load the same document (dev server or bundled index.html) with the hash.
  // A relative URL keeps it correct in both `tauri dev` and production.
  return `index.html${spec.hash}`;
}

// ── Geometry persistence ─────────────────────────────────────────────────────
// Stored in LOGICAL pixels (what the window constructor + setPosition expect).

interface Geom {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GEOM_KEY = "decks_bridge_viewer_geometry";

function loadAllGeom(): Partial<Record<string, Geom>> {
  try {
    const raw = localStorage.getItem(GEOM_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<string, Geom>>) : {};
  } catch {
    return {};
  }
}

function loadGeom(key: string): Geom | null {
  const g = loadAllGeom()[key];
  return g && Number.isFinite(g.x) && Number.isFinite(g.y) ? g : null;
}

function saveGeom(key: string, geom: Geom): void {
  try {
    const all = loadAllGeom();
    all[key] = geom;
    localStorage.setItem(GEOM_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** Read a live window's geometry and persist it immediately (best-effort). */
async function persistGeomNow(win: TWebviewWindow, key: string): Promise<void> {
  try {
    const scale = await win.scaleFactor();
    const pos = await win.outerPosition(); // physical
    const size = await win.outerSize(); // physical
    saveGeom(key, {
      x: Math.round(pos.x / scale),
      y: Math.round(pos.y / scale),
      width: Math.round(size.width / scale),
      height: Math.round(size.height / scale),
    });
  } catch {
    /* ignore */
  }
}

/** Attach move/resize listeners that persist geometry (best-effort, debounced). */
async function trackGeometry(win: TWebviewWindow, key: string): Promise<void> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const persist = () => void persistGeomNow(win, key);
  const debounced = () => {
    if (t) clearTimeout(t);
    t = setTimeout(persist, 400);
  };
  try {
    await win.onMoved(debounced);
    await win.onResized(debounced);
  } catch {
    /* listeners are best-effort */
  }
}

async function ensureWindow(mode: ViewerMode): Promise<TWebviewWindow | null> {
  const spec = SPECS[mode];
  const WebviewWindow = await tauriWebviewWindow();
  try {
    const existing = await WebviewWindow.getByLabel(spec.label);
    if (existing) {
      await existing.show().catch(() => undefined);
      await existing.setFocus().catch(() => undefined);
      return existing;
    }
  } catch {
    /* getByLabel can reject if the window is mid-teardown; fall through to create */
  }

  const geom = loadGeom(mode);
  // mini + pill honour the always-on-top preference; expanded never floats.
  const alwaysOnTop = spec.alwaysOnTop && getAlwaysOnTopPref();

  try {
    const win = new WebviewWindow(spec.label, {
      url: specUrl(spec),
      title: spec.title,
      width: geom?.width ?? spec.width,
      height: geom?.height ?? spec.height,
      minWidth: spec.minWidth,
      minHeight: spec.minHeight,
      x: geom?.x,
      y: geom?.y,
      resizable: spec.resizable,
      decorations: spec.decorations,
      alwaysOnTop,
      skipTaskbar: spec.skipTaskbar,
      // Only center a fresh expanded window with no saved position.
      center: mode === "expanded" && !geom,
      backgroundColor: "#0e0e10",
      focus: true,
      visible: true,
    });

    void win.once("tauri://error", (e) => {
      console.error(`[windows] failed to create ${spec.label}:`, e.payload);
    });

    // Window creation is ASYNCHRONOUS: the constructor returns a handle
    // immediately and the runtime only later decides whether the window really
    // came up. A non-null handle is therefore not proof of success, so confirm
    // the window actually exists before telling the caller it does — the same
    // "confirm, don't assume" rule closeViewerAndWait applies in reverse.
    if (!(await waitForWindow(spec.label))) {
      console.error(`[windows] ${spec.label} was created but never appeared`);
      return null;
    }

    void trackGeometry(win, mode);
    return win;
  } catch (err) {
    console.error(`[windows] create threw for ${spec.label}:`, err);
    return null;
  }
}

/** Wait until a window with `label` really exists. Returns false on timeout. */
async function waitForWindow(label: string, timeoutMs = 5000): Promise<boolean> {
  const WebviewWindow = await tauriWebviewWindow();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await WebviewWindow.getByLabel(label)) return true;
    } catch {
      /* lookup can reject mid-creation; keep polling until the deadline */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ── Single-viewer invariant ──────────────────────────────────────────────────
//
// EXACTLY ONE viewer surface may be alive at a time (plus the untouched `main`
// window). Lifecycle is owned by the MAIN window: a viewer only *requests* a
// switch (see `requestSwitch`), because a window cannot reliably orchestrate its
// own destruction and then create its replacement — its JS context dies mid-way.
// The main window is always alive, so it can safely close → confirm gone →
// create, in that order.

/**
 * Viewer modes whose window is currently alive.
 *
 * Enumerates once via `getAllWebviewWindows()` (which is what `getByLabel` uses
 * internally). Errors are deliberately NOT swallowed: if this call fails — e.g.
 * the `core:webview:allow-get-all-webviews` capability is missing — every lookup
 * would report "nothing alive", the close step would close nothing, and windows
 * would silently pile up. Failing loudly keeps the invariant trustworthy.
 */
export async function aliveViewers(): Promise<ViewerMode[]> {
  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const labels = new Set((await getAllWebviewWindows()).map((w) => w.label));
    return (Object.keys(LABELS) as ViewerMode[]).filter((m) => labels.has(LABELS[m]));
  } catch (err) {
    console.error("[windows] cannot enumerate windows — single-viewer invariant is unreliable:", err);
    throw err;
  }
}

/**
 * Invariant check: at most one viewer window may exist. Logs always; throws in
 * development so a regression fails loudly instead of silently duplicating.
 */
export async function assertSingleViewerWindow(context = ""): Promise<ViewerMode[]> {
  const alive = await aliveViewers();
  if (alive.length > 1) {
    const msg = `[windows] SINGLE-VIEWER VIOLATION${context ? ` (${context})` : ""}: alive=[${alive.join(", ")}]`;
    console.error(msg);
    if (import.meta.env.DEV) throw new Error(msg);
  }
  return alive;
}

/** Close one viewer and WAIT until it is really gone. Returns false on timeout. */
async function closeViewerAndWait(mode: ViewerMode, timeoutMs = 3000): Promise<boolean> {
  const WebviewWindow = await tauriWebviewWindow();
  try {
    const win = await WebviewWindow.getByLabel(LABELS[mode]);
    if (!win) return true; // already gone
    await persistGeomNow(win, mode); // preserve position/size before destroying
    await win.close();
  } catch (err) {
    console.warn(`[windows] close(${LABELS[mode]}) threw:`, err);
  }
  // Confirm destruction rather than assuming it.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (!(await WebviewWindow.getByLabel(LABELS[mode]))) return true;
    } catch {
      return true; // lookup failing means it's gone
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.error(`[windows] ${LABELS[mode]} did not close within ${timeoutMs}ms`);
  return false;
}

/** Close every viewer window and wait for all of them to be gone. */
async function closeAllViewersAndWait(except?: ViewerMode): Promise<boolean> {
  const alive = (await aliveViewers()).filter((m) => m !== except);
  const results = await Promise.all(alive.map((m) => closeViewerAndWait(m)));
  return results.every(Boolean);
}

/** Show or hide the main window (the Console lives here in the Rec-A layout). */
async function setMainVisible(visible: boolean): Promise<void> {
  const WebviewWindow = await tauriWebviewWindow();
  try {
    const main = await WebviewWindow.getByLabel("main");
    if (!main) return;
    if (visible) {
      await main.show().catch(() => undefined);
      await main.setFocus().catch(() => undefined);
    } else {
      await main.hide().catch(() => undefined);
    }
  } catch (err) {
    console.error("[windows] setMainVisible failed:", err);
  }
}

/**
 * AUTHORITATIVE viewer switch — run this in the MAIN window only.
 *
 * Rec-A model: the Console IS the main window. `expanded` therefore means
 * "show the main window", while `mini`/`pill` are floating companion windows.
 * Only ONE surface is ever presented:
 *   • expanded → close the floating windows, show main
 *   • mini/pill → create the floating window, then hide main
 * Floating windows are still swapped close→confirm→create so two never coexist.
 * If the old floating window won't close we ABORT (never duplicate).
 */
export async function performSwitch(to: ViewerMode): Promise<void> {
  if (to === "expanded") {
    const closed = await closeAllViewersAndWait();
    if (!closed) {
      console.error("[windows] aborting → console: a floating viewer would not close");
      return;
    }
    await setMainVisible(true);
    persistViewerMode("expanded");
    await assertSingleViewerWindow("after switch → console");
    return;
  }

  // → floating (mini / pill): swap any existing floating window first.
  const closed = await closeAllViewersAndWait();
  if (!closed) {
    console.error("[windows] aborting switch — previous floating viewer would not close");
    return;
  }
  const remaining = await aliveViewers();
  if (remaining.length > 0) {
    console.error(`[windows] aborting switch — viewers still alive: ${remaining.join(", ")}`);
    return;
  }

  // Create the replacement BEFORE hiding main, and only hide main once we know
  // the new surface actually exists. ensureWindow swallows its own errors and
  // returns null; hiding main on that path would leave the DJ with a running
  // app, no viewer, and — on macOS — no tray to recover from, i.e. force-quit.
  // Main stays visible on failure so there is always a way back.
  const win = await ensureWindow(to);
  if (!win) {
    console.error(`[windows] aborting switch — ${to} viewer could not be created; keeping console visible`);
    await setMainVisible(true);
    return;
  }

  persistViewerMode(to);
  await assertSingleViewerWindow(`after switch → ${to}`);
  await setMainVisible(false); // one surface at a time: tuck the main console away
}

// ── Cross-window switch request ──────────────────────────────────────────────

const SWITCH_EVENT = "decks://viewer-switch";

/** Called FROM a viewer window: ask the main window to perform the switch. */
export async function requestSwitch(to: ViewerMode): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(SWITCH_EVENT, { to });
}

/**
 * Called ONCE by the MAIN window. Listens for viewer switch requests and runs
 * the authoritative lifecycle. Returns an unlisten function.
 */
export async function initViewerHost(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<{ to: ViewerMode }>(SWITCH_EVENT, (e) => {
    const to = e.payload?.to;
    if (to === "expanded" || to === "mini" || to === "pill") {
      void performSwitch(to).catch((err) => console.error("[windows] switch failed:", err));
    }
  });
  return un;
}

/** Open a viewer surface (from the main window / launcher). */
export async function openViewer(mode: ViewerMode): Promise<void> {
  await performSwitch(mode);
}

/** Close every viewer window (e.g. on sign-out). Leaves `main` alone. */
export async function closeAllViewers(): Promise<void> {
  await closeAllViewersAndWait();
}

/** Apply an always-on-top preference to any live floating viewer windows. */
export async function applyAlwaysOnTop(value: boolean): Promise<void> {
  const WebviewWindow = await tauriWebviewWindow();
  for (const m of ["mini", "pill"] as ViewerMode[]) {
    try {
      const win = await WebviewWindow.getByLabel(LABELS[m]);
      await win?.setAlwaysOnTop(value).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }
}

// ── Viewer-mode persistence ──────────────────────────────────────────────────
// Remember the last viewer surface so re-opening lands where the DJ left off.

const LAST_MODE_KEY = "decks_bridge_viewer_mode";

export function persistViewerMode(mode: ViewerMode): void {
  try {
    localStorage.setItem(LAST_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function loadViewerMode(): ViewerMode {
  try {
    const raw = localStorage.getItem(LAST_MODE_KEY);
    if (raw === "expanded" || raw === "mini" || raw === "pill") return raw;
  } catch {
    /* ignore */
  }
  return "expanded";
}

// ── Main-window sizing (Rec-A: the main window hosts the Console) ────────────
//
// The pairing screen is deliberately compact; once paired the same window must
// grow into real Console dimensions. Size/position are remembered per surface
// and clamped to a visible monitor so a window can never restore off-screen
// (e.g. after unplugging an external display).

const CONSOLE_GEOM_KEY = "main-console";
const CONSOLE_DEFAULT = { width: 1024, height: 720 };
const CONSOLE_MIN = { width: 900, height: 620 };
const PAIRING_SIZE = { width: 480, height: 680 };
const PAIRING_MIN = { width: 420, height: 560 };

/** True when the saved rect sits (mostly) inside one of the attached monitors. */
async function isOnScreen(g: Geom): Promise<boolean> {
  try {
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const mons = await availableMonitors();
    if (!mons.length) return true; // can't tell — don't fight the OS
    return mons.some((m) => {
      const s = m.scaleFactor || 1;
      const mx = m.position.x / s;
      const my = m.position.y / s;
      const mw = m.size.width / s;
      const mh = m.size.height / s;
      // Require the title bar to be grabbable, not just any overlap.
      return g.x + 80 >= mx && g.x + 80 <= mx + mw && g.y >= my - 4 && g.y + 40 <= my + mh;
    });
  } catch {
    return true;
  }
}

/** Grow the main window into Console dimensions (called once paired). */
export async function applyConsoleWindow(): Promise<void> {
  try {
    const { getCurrentWindow, LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.setResizable(true).catch(() => undefined);
    await win.setMinSize(new LogicalSize(CONSOLE_MIN.width, CONSOLE_MIN.height)).catch(() => undefined);

    const saved = loadGeom(CONSOLE_GEOM_KEY);
    if (saved && (await isOnScreen(saved))) {
      await win.setSize(new LogicalSize(Math.max(saved.width, CONSOLE_MIN.width), Math.max(saved.height, CONSOLE_MIN.height)));
      await win.setPosition(new LogicalPosition(saved.x, saved.y));
    } else {
      // First paired launch (or the saved spot is gone) → default + centered.
      await win.setSize(new LogicalSize(CONSOLE_DEFAULT.width, CONSOLE_DEFAULT.height));
      await win.center().catch(() => undefined);
    }
    // Remember whatever the DJ resizes/moves it to from here on.
    void trackGeometry(win as unknown as TWebviewWindow, CONSOLE_GEOM_KEY);
  } catch (err) {
    console.error("[windows] applyConsoleWindow failed:", err);
  }
}

/** Shrink the main window back to the compact pairing card (on sign-out). */
export async function applyPairingWindow(): Promise<void> {
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.setMinSize(new LogicalSize(PAIRING_MIN.width, PAIRING_MIN.height)).catch(() => undefined);
    await win.setSize(new LogicalSize(PAIRING_SIZE.width, PAIRING_SIZE.height));
    await win.center().catch(() => undefined);
  } catch (err) {
    console.error("[windows] applyPairingWindow failed:", err);
  }
}
