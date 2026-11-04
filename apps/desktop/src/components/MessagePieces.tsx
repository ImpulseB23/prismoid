// Renders the text, link, mention and emote pieces of one message. Shared
// by the chat feed and the user card so emotes look identical in both.

import { Component, For } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MessagePiece } from "../lib/emoteSpans";
import { emoteImages } from "../lib/emoteImage";
import { usePane } from "../lib/pane";
import { nameStyle } from "../lib/paint";
import { nameContrast } from "../stores/themeStore";
import {
  endEmoteHover,
  hoverEmote,
  inspectEmote,
  inspectLoading,
} from "../stores/emoteCardStore";

const Piece: Component<{
  piece: MessagePiece;
  onMention?: (login: string) => void;
}> = (props) => {
  const pane = usePane();
  const p = props.piece;
  if (p.kind === "text") {
    return <span>{p.text}</span>;
  }
  if (p.kind === "mention") {
    // In their chat color once they have spoken in the channel.
    const color = () => pane?.session().chatters.byLogin(p.login)?.color;
    const open = props.onMention;
    return (
      <span
        class="msg__mention"
        style={nameStyle(color(), undefined, nameContrast()).style}
        role={open ? "button" : undefined}
        tabIndex={open ? 0 : undefined}
        onClick={(e) => {
          if (!open) return;
          e.stopPropagation();
          open(p.login);
        }}
        onKeyDown={(e) => {
          if (!open || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          e.stopPropagation();
          open(p.login);
        }}
      >
        {p.text}
      </span>
    );
  }
  if (p.kind === "link") {
    return (
      <a
        class="msg__link"
        href={p.href}
        title={p.href}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void openUrl(p.href).catch((err: unknown) =>
            console.error("open link", err),
          );
        }}
      >
        {p.text}
      </a>
    );
  }
  const { primary, overlays } = p;
  const images = () => emoteImages(primary.emote);
  const title = [primary, ...overlays].map((r) => r.emote.code).join(" + ");
  return (
    <span
      class="msg__emote"
      classList={{
        "msg__emote--loading": inspectLoading() === primary.emote.id,
      }}
      aria-busy={inspectLoading() === primary.emote.id}
      role="button"
      tabIndex={0}
      aria-label={`${title} emote`}
      onPointerEnter={(e) =>
        hoverEmote(
          e.currentTarget,
          primary.emote,
          overlays.map((o) => o.emote),
          pane,
        )
      }
      onPointerLeave={endEmoteHover}
      style={{
        width: `${primary.width}px`,
        height: `${primary.height}px`,
      }}
      onClick={(e) => {
        e.stopPropagation();
        inspectEmote(primary.emote, pane);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          inspectEmote(primary.emote, pane);
        }
      }}
    >
      <img
        src={images().x1}
        srcset={
          images().x2 ? `${images().x1} 1x, ${images().x2} 2x` : undefined
        }
        alt={primary.emote.code}
        width={primary.width}
        height={primary.height}
        draggable={false}
        class="msg__emote-img"
      />
      <For each={overlays}>
        {(overlay) => (
          <img
            src={emoteImages(overlay.emote).x1}
            alt={overlay.emote.code}
            width={overlay.width}
            height={overlay.height}
            draggable={false}
            class="msg__emote-overlay"
            style={{
              left: `${(primary.width - overlay.width) / 2}px`,
              top: `${(primary.height - overlay.height) / 2}px`,
            }}
          />
        )}
      </For>
    </span>
  );
};

const MessagePieces: Component<{
  pieces: MessagePiece[];
  /** Clicking an @mention; without it mentions are only styled. */
  onMention?: (login: string) => void;
}> = (props) => (
  <For each={props.pieces}>
    {(piece) => <Piece piece={piece} onMention={props.onMention} />}
  </For>
);

export default MessagePieces;
