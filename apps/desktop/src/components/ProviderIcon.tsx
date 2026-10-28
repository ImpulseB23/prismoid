// Brand mark of the service an emote comes from. Twitch and 7TV are their
// published vector marks, BTTV and FFZ their site icons.

import { Component } from "solid-js";
import type { EmoteMeta } from "../stores/chatStore";
import bttv from "../assets/providers/bttv.png";
import ffz from "../assets/providers/ffz.png";

const ProviderIcon: Component<{
  provider: EmoteMeta["provider"];
  size?: number;
}> = (props) => {
  const size = () => props.size ?? 14;
  switch (props.provider) {
    case "twitch":
      return (
        <svg
          class="provider-icon provider-icon--twitch"
          width={size()}
          height={size()}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"
          />
        </svg>
      );
    case "7tv":
      return (
        <svg
          class="provider-icon provider-icon--7tv"
          width={size()}
          height={size()}
          viewBox="8 24 108.148 80"
          aria-hidden="true"
        >
          <g fill="currentColor">
            <path d="M90.986 45.953L95.9196 37.3498L98.584 32.801L93.65 24.1978V24H67.3036L77.1712 41.2064L79.9344 45.953H90.986Z" />
            <path d="M36.6158 103.703L66.2184 52.0842L69.8692 45.7554L60.0016 28.549L57.2388 24.099H15.598L10.6642 32.7022L8 37.251L12.9338 45.8542V46.052H44.5098L19.841 89.068L16.3874 95.1992L21.3212 103.802V104H36.6158" />
            <path d="M77.862 103.703H92.9592L112.694 69.29L116.148 63.357L111.214 54.7538V54.556H96.0184L86.1508 71.7624L85.46 73.048L75.5924 55.8415L74.902 54.556L65.0344 71.7624L62.2716 76.5088L77.0728 102.318L77.862 103.703Z" />
          </g>
        </svg>
      );
    case "bttv":
    case "ffz":
      return (
        <img
          class="provider-icon"
          src={props.provider === "bttv" ? bttv : ffz}
          width={size()}
          height={size()}
          alt=""
          draggable={false}
        />
      );
  }
};

export default ProviderIcon;
