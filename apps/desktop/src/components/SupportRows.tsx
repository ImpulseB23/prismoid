// Settings > Help > Troubleshooting: copy logs for a bug report, reset the
// app, or uninstall it. The destructive ones take a second tap.

import { Component, Show, createSignal } from "solid-js";
import { relaunch } from "@tauri-apps/plugin-process";
import { getSupportBundle } from "../lib/log";
import { resetAllData, resetSettings, isResetError } from "../lib/reset";
import { isUninstallError, uninstallApp } from "../lib/uninstall";
import { createConfirmTap } from "../lib/confirmTap";

const COPIED_MS = 2000;

// What the app keeps in localStorage. Settings alone is the first key; a
// full reset clears every key the app owns.
const SETTINGS_KEY = "prismoid.settings";
const APP_PREFIX = "prismoid.";

function clearStorage(all: boolean): void {
  if (!all) {
    localStorage.removeItem(SETTINGS_KEY);
    return;
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(APP_PREFIX)) localStorage.removeItem(key);
  }
}

const describe = (e: unknown): string => {
  if (isResetError(e)) return `Reset stopped: ${e.message}`;
  if (isUninstallError(e)) {
    return e.kind === "not_installed"
      ? "This copy wasn't installed with the installer. Uninstall it from Windows Settings > Apps."
      : `The uninstaller would not start: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
};

const SupportRows: Component = () => {
  const [copying, setCopying] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const settingsTap = createConfirmTap();
  const allTap = createConfirmTap();
  const uninstallTap = createConfirmTap();

  const copyLogs = async () => {
    setCopying(true);
    setError(null);
    try {
      await navigator.clipboard.writeText(await getSupportBundle());
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch (e) {
      setError(describe(e));
    } finally {
      setCopying(false);
    }
  };

  const reset = async (all: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await (all ? resetAllData() : resetSettings());
      clearStorage(all);
      await relaunch();
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  };

  const uninstall = async () => {
    setBusy(true);
    setError(null);
    try {
      await uninstallApp();
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div class="settings__group-label">Troubleshooting</div>
      <div class="settings__row">
        <div class="settings__text">
          <span class="settings__name">Copy logs</span>
          <span class="settings__hint">
            Copies what you need for a bug report: app version, system details
            and recent logs, with sign-in tokens removed.
          </span>
        </div>
        <button
          type="button"
          class="btn btn--outline"
          disabled={copying()}
          aria-busy={copying()}
          onClick={() => void copyLogs()}
        >
          <Show when={copying()}>
            <span class="palette__spinner" aria-hidden="true" />
          </Show>
          {copied() ? "Copied" : "Copy logs"}
        </button>
      </div>
      <div class="settings__row">
        <div class="settings__text">
          <span class="settings__name">Reset settings</span>
          <span class="settings__hint">
            Puts every setting back to its default and restarts. You stay signed
            in and keep your tabs and chat history.
          </span>
        </div>
        <button
          type="button"
          class="btn btn--outline"
          classList={{ "btn--danger": settingsTap.armed() }}
          disabled={busy()}
          onClick={() => {
            if (settingsTap.tap()) void reset(false);
          }}
        >
          {settingsTap.armed() ? "Reset and restart?" : "Reset settings"}
        </button>
      </div>
      <div class="settings__row">
        <div class="settings__text">
          <span class="settings__name">Reset everything</span>
          <span class="settings__hint">
            Signs you out, deletes chat history, tabs and settings, and starts
            fresh as if just installed. Logs are kept.
          </span>
        </div>
        <button
          type="button"
          class="btn btn--outline"
          classList={{ "btn--danger": allTap.armed() }}
          disabled={busy()}
          onClick={() => {
            if (allTap.tap()) void reset(true);
          }}
        >
          {allTap.armed() ? "Erase everything?" : "Reset everything"}
        </button>
      </div>
      <div class="settings__row">
        <div class="settings__text">
          <span class="settings__name">Uninstall</span>
          <span class="settings__hint">
            Opens the Windows uninstaller and closes Prismoid.
          </span>
        </div>
        <button
          type="button"
          class="btn btn--outline btn--danger"
          classList={{ "btn--armed": uninstallTap.armed() }}
          disabled={busy()}
          onClick={() => {
            if (uninstallTap.tap()) void uninstall();
          }}
        >
          {uninstallTap.armed() ? "Uninstall Prismoid?" : "Uninstall"}
        </button>
      </div>
      <Show when={error()}>
        {(e) => (
          <div class="dialog__error" role="alert">
            {e()}
          </div>
        )}
      </Show>
    </>
  );
};

export default SupportRows;
