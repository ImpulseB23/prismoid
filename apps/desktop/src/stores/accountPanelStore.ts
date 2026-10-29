// Whether the account panel from the header avatar is open.

import { createSignal } from "solid-js";

const [accountOpen, setAccountOpen] = createSignal(false);

export { accountOpen, setAccountOpen };
