// The webview's warnings and errors join the host's log file, so a bug
// report carries both sides. Console output itself is left alone for
// devtools.

import { invoke } from "@tauri-apps/api/core";
import { error, warn } from "@tauri-apps/plugin-log";

type Level = "warn" | "error";
type Sink = (message: string) => Promise<void>;

export function forwardConsole(
  target: Pick<Console, Level> = console,
  sinks: Record<Level, Sink> = { warn, error },
): void {
  for (const level of ["warn", "error"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      original(...args);
      void sinks[level](args.map(describe).join(" ")).catch(() => {});
    };
  }
}

export function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function openLogDir(): Promise<void> {
  return invoke("open_log_dir");
}

/** App version, platform and the newest log lines with secrets redacted. */
export function getSupportBundle(): Promise<string> {
  return invoke("support_bundle");
}
