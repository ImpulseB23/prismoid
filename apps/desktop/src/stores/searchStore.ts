// Whether chat search is open; Ctrl+F and the header both open it.

import { createSignal } from "solid-js";

const [searchOpen, setSearchOpen] = createSignal(false);

export { searchOpen, setSearchOpen };
