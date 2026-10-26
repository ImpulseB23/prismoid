// Whether the channel picker is open. Shared because the header's channel
// button, the tab strip's add button and the Ctrl+K shortcut all open it.

import { createSignal } from "solid-js";

const [pickerOpen, setPickerOpen] = createSignal(false);

export { pickerOpen, setPickerOpen };
