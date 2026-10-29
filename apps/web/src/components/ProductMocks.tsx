import { For } from "solid-js";
import "./ProductMocks.css";

// Still pictures of the real app's panels, drawn from its own class names
// and colors in apps/desktop/src/styles.css. The text around each one says
// what it shows, so they stay hidden from screen readers.

const HISTORY = [
  { time: "23:41", name: "sleepyfern", color: "#6fd0ff", text: "gn chat" },
  {
    time: "23:42",
    name: "crumbs_42",
    color: "#ffb020",
    text: "same time tomorrow?",
    emote: true,
  },
  { time: "23:42", name: "pixelgoose", color: "#bf94ff", text: "yep, 6pm" },
];

const TODAY = [
  {
    time: "18:02",
    name: "crumbs_42",
    color: "#ffb020",
    text: "back like I never left",
    emote: true,
  },
  {
    time: "18:03",
    name: "noodle_hours",
    color: "#ff4d8d",
    text: "wait it still has last night's chat",
  },
];

export function ChatShot() {
  return (
    <div class="shot chat-shot" aria-hidden="true">
      <div class="shot-tabs">
        <span class="shot-tab shot-tab--on">
          <span class="shot-tab__avatar" style={{ background: "#bf94ff" }} />
          pixelgoose
        </span>
        <span class="shot-tab">
          <span class="shot-tab__avatar" style={{ background: "#6fd0ff" }} />
          moss_rally <b>24</b>
        </span>
        <span class="shot-tab">
          <span class="shot-tab__avatar" style={{ background: "#ff7a80" }} />
          quietkettle <b>3</b>
        </span>
        <span class="shot-tab shot-tab--hide-sm">
          <span class="shot-tab__avatar" style={{ background: "#6bc955" }} />
          tabby_owl
        </span>
        <span class="shot-tabs__add">+</span>
      </div>
      <div class="chat-shot__feed">
        <For each={[...HISTORY, ...TODAY]}>
          {(m, i) => (
            <div
              class="shot-msg"
              classList={{ "shot-msg--alt": i() % 2 === 1 }}
            >
              <span class="shot-msg__time">{m.time}</span>
              <span class="shot-msg__user" style={{ color: m.color }}>
                {m.name}
              </span>
              <span>
                {m.text}
                {m.emote && <span class="shot-emote shot-emote--wave" />}
              </span>
            </div>
          )}
        </For>
        <div class="shot-msg shot-msg--alt">
          <span class="shot-msg__time">18:03</span>
          <span class="shot-msg__user" style={{ color: "#6bc955" }}>
            tabby_owl
          </span>
          <span>
            <span class="shot-emote shot-emote--wave shot-emote--picked" />{" "}
            <span class="shot-emote shot-emote--blob" />
          </span>
        </div>
      </div>
      <div class="emote-shot">
        <div class="emote-shot__hero">
          <span class="shot-emote shot-emote--wave shot-emote--big" />
        </div>
        <div class="emote-shot__head">
          <span class="emote-shot__code">gooseWave</span>
          <span class="emote-shot__by">by honkworks</span>
        </div>
        <dl class="emote-shot__facts">
          <dt>From</dt>
          <dd>
            <span class="emote-shot__provider">7TV</span>
            pixelgoose's Emotes
          </dd>
          <dt>Type</dt>
          <dd>Animated</dd>
          <dt>Added</dt>
          <dd>3 weeks ago</dd>
        </dl>
      </div>
    </div>
  );
}

const MODES = [
  { name: "Slow", detail: "30 sec", on: true },
  { name: "Followers", detail: "10 min", on: false },
  { name: "Subs only", detail: "On", on: false },
  { name: "Emotes only", detail: "On", on: false },
  { name: "Unique", detail: "No repeats", on: true },
  { name: "Delay", detail: "2 sec", on: false },
];

export function ModFeedShot() {
  return (
    <div class="shot mod-feed" aria-hidden="true">
      <div class="shot-msg">
        <span class="shot-msg__user" style={{ color: "#6fd0ff" }}>
          sleepyfern
        </span>
        <span>did anyone else hear that</span>
      </div>
      <div class="shot-msg shot-msg--deleted">
        <span class="shot-msg__user" style={{ color: "#8f8f8f" }}>
          cheap_views_4421
        </span>
        <span>best viewers here, link in my bio</span>
      </div>
      <div class="shot-msg shot-msg--notice">
        <span class="shot-msg__notice">
          crumbs_42 timed out cheap_views_4421 for 10 min: selling viewers
        </span>
      </div>
      <div class="shot-msg">
        <span class="shot-msg__user" style={{ color: "#ffb020" }}>
          crumbs_42
        </span>
        <span>not today</span>
      </div>
      <div class="shot-msg shot-msg--notice">
        <span class="shot-msg__notice">
          pixelgoose banned loudbird_99: third time asked
        </span>
      </div>
    </div>
  );
}

export function ChatManagerShot() {
  return (
    <div class="shot cm-shot" aria-hidden="true">
      <div class="cm-shot__head">
        <span class="cm-shot__avatar" />
        <span class="cm-shot__who">
          <span class="cm-shot__title">Chat manager</span>
          <span class="cm-shot__sub">pixelgoose</span>
        </span>
      </div>
      <div class="cm-shot__room">
        <div class="cm-shot__room-head">
          <span>Room</span>
          <span class="cm-shot__summary">Slow, unique</span>
        </div>
        <div class="cm-shot__tiles">
          <For each={MODES}>
            {(m) => (
              <span
                class="cm-shot__tile"
                classList={{ "cm-shot__tile--on": m.on }}
              >
                <span class="cm-shot__tile-name">{m.name}</span>
                <span class="cm-shot__tile-detail">{m.detail}</span>
              </span>
            )}
          </For>
        </div>
      </div>
      <div class="cm-shot__tabs">
        <span class="cm-shot__tab cm-shot__tab--on">
          Held by AutoMod <b>2</b>
        </span>
        <span class="cm-shot__tab">Mod log</span>
      </div>
      <div class="cm-shot__list">
        <div class="cm-shot__held">
          <span class="shot-msg__user" style={{ color: "#ff7a80" }}>
            grumpy_spoon
          </span>
          <span class="cm-shot__held-text">this streamer is ******</span>
          <span class="cm-shot__held-actions">
            <span>Allow</span>
            <span>Deny</span>
          </span>
        </div>
        <div class="cm-shot__held">
          <span class="shot-msg__user" style={{ color: "#a9c6ff" }}>
            new_acct_0417
          </span>
          <span class="cm-shot__held-text">check out my ******* channel</span>
          <span class="cm-shot__held-actions">
            <span>Allow</span>
            <span>Deny</span>
          </span>
        </div>
      </div>
      <div class="cm-shot__foot">
        <span class="cm-shot__foot-hint">Rare, so it asks twice</span>
        <span class="shot-btn shot-btn--danger">Clear chat</span>
      </div>
    </div>
  );
}

export function ManagerShot() {
  return (
    <div class="shot sm-shot" aria-hidden="true">
      <div class="sm-shot__chat">
        <div class="shot-msg">
          <span class="shot-msg__user" style={{ color: "#ffb020" }}>
            crumbs_42
          </span>
          <span>chat still moving under there</span>
        </div>
        <div class="shot-msg shot-msg--alt">
          <span class="shot-msg__user" style={{ color: "#6fd0ff" }}>
            sleepyfern
          </span>
          <span>poll when?</span>
        </div>
      </div>
      <div class="sm-shot__curtain">
        <div class="sm-shot__tabs">
          <span class="sm-shot__tab sm-shot__tab--on">Live</span>
          <span class="sm-shot__tab">Ads</span>
          <span class="sm-shot__tab">Polls and predictions</span>
        </div>
        <div class="sm-shot__now">
          <div class="sm-shot__row">
            <span class="sm-shot__stat">
              <span class="sm-shot__status">
                <span class="sm-shot__dot" />
                Live
              </span>
              <span class="sm-shot__value sm-shot__value--big">2:47:13</span>
            </span>
            <span class="sm-shot__stat">
              <span class="sm-shot__label">Watching</span>
              <span class="sm-shot__value">1,204</span>
            </span>
            <span class="sm-shot__ad">
              <span class="sm-shot__stat sm-shot__stat--end">
                <span class="sm-shot__label">Next ad, 90 sec</span>
                <span class="sm-shot__value">in 4:12</span>
              </span>
              <span class="shot-btn">Snooze 5 min</span>
              <span class="shot-btn shot-btn--solid">Run ad</span>
            </span>
          </div>
          <div class="sm-shot__rail">
            <div class="sm-shot__bar">
              <span class="sm-shot__track" />
              <span class="sm-shot__elapsed" />
              <span
                class="sm-shot__ad-block"
                style={{ left: "18%", width: "3%" }}
              />
              <span
                class="sm-shot__ad-block"
                style={{ left: "46%", width: "3%" }}
              />
              <span
                class="sm-shot__next"
                style={{ left: "77%", width: "3%" }}
              />
              <span class="sm-shot__tick" style={{ left: "31%" }} />
              <span class="sm-shot__tick" style={{ left: "58%" }} />
              <span class="sm-shot__now-line" style={{ left: "72%" }} />
            </div>
            <div class="sm-shot__labels">
              <span style={{ left: "0%" }}>Start</span>
              <span class="sm-shot__label--ad" style={{ left: "18%" }}>
                Ad
              </span>
              <span class="sm-shot__label--marker" style={{ left: "31%" }}>
                Boss down
              </span>
              <span class="sm-shot__label--ad" style={{ left: "46%" }}>
                Ad
              </span>
              <span class="sm-shot__label--now" style={{ left: "70%" }}>
                Now
              </span>
            </div>
          </div>
        </div>
        <div class="sm-shot__body">
          <div class="sm-shot__card">
            <span class="sm-shot__card-title">Stream setup</span>
            <span class="sm-shot__field">
              <span class="sm-shot__field-label">Title</span>
              <span class="sm-shot__input">
                first time in the ice level, no spoilers please
              </span>
            </span>
            <span class="sm-shot__field">
              <span class="sm-shot__field-label">Category</span>
              <span class="sm-shot__category">
                <span class="sm-shot__art" />
                Goose Tycoon
              </span>
            </span>
            <span class="sm-shot__field">
              <span class="sm-shot__field-label">Tags</span>
              <span class="sm-shot__tags">
                <span class="sm-shot__chip">English</span>
                <span class="sm-shot__chip">Blind</span>
                <span class="sm-shot__chip">Chill</span>
                <span class="sm-shot__chip">NoBackseating</span>
              </span>
            </span>
          </div>
        </div>
        <div class="sm-shot__handle" />
      </div>
    </div>
  );
}
