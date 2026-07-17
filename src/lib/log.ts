import { invoke } from "@tauri-apps/api/core";

export async function logDiagnostic(category: string, message: string): Promise<void> {
  try {
    await invoke("log_diagnostic", { category, message });
  } catch {
    console.log(`[${category}] ${message}`);
  }
}

export async function getLogDir(): Promise<string | null> {
  try {
    return await invoke<string>("get_log_dir");
  } catch {
    return null;
  }
}
