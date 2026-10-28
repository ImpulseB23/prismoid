// Right-click across the whole window. Surfaces with a menu of their own
// (chat rows) open it first and mark the event handled; everything else
// lands here: text fields get Cut/Copy/Paste/Select all, links get Open and
// Copy, selected text gets Copy, and anywhere else right-click does nothing
// rather than showing the browser's menu.

import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  item,
  openContextMenu,
  separator,
  type MenuItem,
} from "../stores/contextMenuStore";

type TextField = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel"]);

function textFieldOf(target: Element): TextField | null {
  const el = target.closest("input, textarea");
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) return el;
  return null;
}

// Replaces the selection the way typing would, so the field's own input
// handlers see the change.
function replaceSelection(field: TextField, text: string): void {
  field.setRangeText(
    text,
    field.selectionStart ?? 0,
    field.selectionEnd ?? 0,
    "end",
  );
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

const report = (what: string) => (err: unknown) => console.error(what, err);

export function fieldMenuItems(field: TextField): MenuItem[] {
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? 0;
  const selected = field.value.slice(start, end);
  const editable = !field.readOnly && !field.disabled;
  const items: MenuItem[] = [];
  if (editable && selected) {
    items.push(
      item("Cut", () => {
        void navigator.clipboard.writeText(selected).then(() => {
          replaceSelection(field, "");
        }, report("cut"));
      }),
    );
  }
  if (selected) {
    items.push(
      item("Copy", () => {
        void navigator.clipboard.writeText(selected).catch(report("copy"));
      }),
    );
  }
  if (editable) {
    items.push(
      item("Paste", () => {
        void readText().then((text) => {
          field.focus();
          replaceSelection(field, text);
        }, report("paste"));
      }),
    );
  }
  if (field.value) {
    if (items.length > 0) items.push(separator);
    items.push(
      item("Select all", () => {
        field.focus();
        field.select();
      }),
    );
  }
  return items;
}

export function linkMenuItems(href: string): MenuItem[] {
  return [
    item("Open link", () => void openUrl(href).catch(report("open link"))),
    item("Copy link", () => {
      void navigator.clipboard.writeText(href).catch(report("copy link"));
    }),
  ];
}

function onContextMenu(e: MouseEvent): void {
  if (e.defaultPrevented) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target) {
    e.preventDefault();
    return;
  }
  const field = textFieldOf(target);
  if (field) {
    openContextMenu(e, fieldMenuItems(field));
    return;
  }
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (link && /^https?:/i.test(link.href)) {
    openContextMenu(e, linkMenuItems(link.href));
    return;
  }
  const selected = window.getSelection()?.toString() ?? "";
  if (selected) {
    openContextMenu(e, [
      item("Copy", () => {
        void navigator.clipboard.writeText(selected).catch(report("copy"));
      }),
    ]);
    return;
  }
  e.preventDefault();
}

/** Takes over right-click for the whole window. Returns a stop function. */
export function installContextMenus(): () => void {
  document.addEventListener("contextmenu", onContextMenu);
  return () => document.removeEventListener("contextmenu", onContextMenu);
}
