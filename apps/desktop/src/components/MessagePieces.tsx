// Renders the text, link and emote pieces of one message. Shared by the
// chat feed and the user card so emotes look identical in both.

import { Component, For } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MessagePiece } from "../lib/emoteSpans";
import { usePane } from "../lib/pane";
import {
  endEmoteHover,
  hoverEmote,
  inspectEmote,
  inspectLoading,
} from "../stores/emoteCardStore";

const Piece: Component<{ piece: MessagePiece }> = (props) => {
  const pane = usePane();
  const p = props.piece;
  if (p.kind === "text") {
    return <span>{p.text}</span>;
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
        src={primary.emote.url_1x}
        srcset={
          primary.emote.url_2x
            ? `${primary.emote.url_1x} 1x, ${primary.emote.url_2x} 2x`
            : undefined
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
            src={overlay.emote.url_1x}
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

const MessagePieces: Component<{ pieces: MessagePiece[] }> = (props) => (
  <For each={props.pieces}>{(piece) => <Piece piece={piece} />}</For>
);

export default MessagePieces;
