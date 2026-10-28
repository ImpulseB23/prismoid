// Whether the mod log panel is open; the mod bar opens it.

import { createSignal } from "solid-js";

const [modLogOpen, setModLogOpen] = createSignal(false);

export { modLogOpen, setModLogOpen };
