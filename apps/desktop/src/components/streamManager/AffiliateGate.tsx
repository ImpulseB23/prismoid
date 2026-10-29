// Greys out a section Twitch only opens to Affiliates and Partners and says
// why, so a channel that is neither still sees what is there. Inert, so its
// controls take neither clicks nor focus. Shown as usual until the channel's
// status has loaded.

import { Component, JSX, Show } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";

export const AFFILIATE_GUIDE =
  "https://help.twitch.tv/s/article/joining-the-affiliate-program";

const AffiliateGate: Component<{
  monetized: boolean | undefined;
  what: string;
  children: JSX.Element;
}> = (props) => {
  const locked = () => props.monetized === false;
  return (
    <div class="sm-gate">
      <Show when={locked()}>
        <div class="sm-gate__note" role="note">
          <strong>{props.what} are for Twitch Affiliates and Partners.</strong>
          <span>
            Twitch turns them on for your channel once you reach Affiliate.
          </span>
          <button
            type="button"
            class="btn btn--small btn--outline sm-gate__link"
            onClick={() =>
              void openUrl(AFFILIATE_GUIDE).catch((err: unknown) =>
                console.error("affiliate guide", err),
              )
            }
          >
            How to reach Affiliate
          </button>
        </div>
      </Show>
      <div
        class="sm-gate__body"
        classList={{ "sm-gate__body--locked": locked() }}
        inert={locked()}
      >
        {props.children}
      </div>
    </div>
  );
};

export default AffiliateGate;
