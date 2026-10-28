// Whether the chat modes panel is open. Shared because the header's shield
// button and the mod bar both open it.

import { createSignal } from "solid-js";

const [modesOpen, setModesOpen] = createSignal(false);

export { modesOpen, setModesOpen };
