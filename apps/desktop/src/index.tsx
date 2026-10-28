import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { boot } from "./boot";
import { forwardConsole } from "./lib/log";

forwardConsole();

boot(getCurrentWindow().label, document.getElementById("root")!).catch(
  (err: unknown) => console.error("failed to boot window", err),
);
