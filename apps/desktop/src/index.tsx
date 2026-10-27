import "./styles.css";
import { render } from "solid-js/web";
import App from "./App";
import { forwardConsole } from "./lib/log";

forwardConsole();

render(() => <App />, document.getElementById("root")!);
