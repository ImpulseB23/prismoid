//! Twitch IRC lines mapped onto the live message shape. Two sources send
//! them: the sidecar's read-only IRC connection for channels where EventSub
//! refuses the chat (a banned or timed-out account), and the recent-messages
//! backlog service. Both speak IRCv3 with Twitch's tags, so one parser
//! serves them.

use crate::message::{
    badge_flags, compute_effective_ts, Badge, ChatEvent, ChatNotice, Platform, ReplyParent,
    UnifiedMessage,
};

/// What one line turned into.
#[derive(Debug, Clone)]
pub enum IrcItem {
    Message {
        message: Box<UnifiedMessage>,
        /// Set by the backlog service's `rm-deleted` tag on a message a
        /// moderator removed after it was sent.
        deleted: bool,
        /// Twitch's `first-msg` tag: the chatter's first message in the channel.
        first: bool,
    },
    Event(ChatEvent),
}

/// Parses one raw line. `fallback_channel` fills `channel_id` when the line
/// carries no `room-id` tag. Lines that are not chat (ROOMSTATE, NOTICE,
/// PING) and lines missing what a row needs return `None`.
pub fn parse_line(line: &str, fallback_channel: Option<&str>) -> Option<IrcItem> {
    let msg = IrcLine::parse(line)?;
    let channel_id = msg
        .tag("room-id")
        .filter(|id| !id.is_empty())
        .or(fallback_channel)?
        .to_owned();
    match msg.command {
        "PRIVMSG" => privmsg(&msg, channel_id),
        "USERNOTICE" => usernotice(&msg, channel_id),
        "CLEARCHAT" => Some(IrcItem::Event(match msg.tag("target-user-id") {
            Some(target) if !target.is_empty() => ChatEvent::UserCleared {
                channel_id,
                target_user_id: target.to_owned(),
                target_user_login: msg.params.get(1).copied().unwrap_or_default().to_owned(),
                target_user_name: String::new(),
            },
            _ => ChatEvent::ChatCleared { channel_id },
        })),
        "CLEARMSG" => Some(IrcItem::Event(ChatEvent::MessageDeleted {
            channel_id,
            message_id: msg.tag("target-msg-id")?.to_owned(),
            target_user_id: String::new(),
        })),
        _ => None,
    }
}

fn privmsg(line: &IrcLine<'_>, channel_id: String) -> Option<IrcItem> {
    let id = line.tag("id")?;
    let username = line.nick()?.to_owned();
    let text = strip_action(line.params.last().copied().unwrap_or_default());
    let badges = parse_badges(
        line.tag("badges").unwrap_or_default(),
        line.tag("badge-info").unwrap_or_default(),
    );
    let (is_broadcaster, is_mod, is_subscriber) = badge_flags(&badges);
    let (timestamp, arrival_time) = line.times()?;
    let reply_to = line.tag("reply-parent-msg-id").filter(|s| !s.is_empty());

    Some(IrcItem::Message {
        deleted: line.tag("rm-deleted") == Some("1"),
        first: line.tag("first-msg") == Some("1"),
        message: Box::new(UnifiedMessage {
            id: id.to_owned(),
            platform: Platform::Twitch,
            timestamp,
            arrival_time,
            effective_ts: compute_effective_ts(timestamp, arrival_time),
            arrival_seq: 0,
            display_name: line.display_name(&username),
            username,
            platform_user_id: line.tag("user-id").unwrap_or_default().to_owned(),
            channel_id,
            message_text: text.to_owned(),
            badges,
            is_mod,
            is_subscriber,
            is_broadcaster,
            color: line
                .tag("color")
                .filter(|c| !c.is_empty())
                .map(str::to_owned),
            reply_to: reply_to.map(str::to_owned),
            reply_parent: reply_to.map(|_| ReplyParent {
                user_login: line
                    .tag("reply-parent-user-login")
                    .unwrap_or_default()
                    .to_owned(),
                user_name: line
                    .tag("reply-parent-display-name")
                    .unwrap_or_default()
                    .to_owned(),
                body: line
                    .tag("reply-parent-msg-body")
                    .unwrap_or_default()
                    .to_owned(),
                thread_id: line
                    .tag("reply-thread-parent-msg-id")
                    .unwrap_or_default()
                    .to_owned(),
            }),
            notice: None,
            emote_spans: Vec::new(),
        }),
    })
}

fn usernotice(line: &IrcLine<'_>, channel_id: String) -> Option<IrcItem> {
    let id = line.tag("id")?;
    let username = line.tag("login").unwrap_or_default().to_owned();
    let text = line.params.get(1).copied().unwrap_or_default();
    let badges = parse_badges(
        line.tag("badges").unwrap_or_default(),
        line.tag("badge-info").unwrap_or_default(),
    );
    let (is_broadcaster, is_mod, is_subscriber) = badge_flags(&badges);
    let (timestamp, arrival_time) = line.times()?;

    Some(IrcItem::Message {
        deleted: line.tag("rm-deleted") == Some("1"),
        first: false,
        message: Box::new(UnifiedMessage {
            id: id.to_owned(),
            platform: Platform::Twitch,
            timestamp,
            arrival_time,
            effective_ts: compute_effective_ts(timestamp, arrival_time),
            arrival_seq: 0,
            display_name: line.display_name(&username),
            username,
            platform_user_id: line.tag("user-id").unwrap_or_default().to_owned(),
            channel_id,
            message_text: text.to_owned(),
            badges,
            is_mod,
            is_subscriber,
            is_broadcaster,
            color: line
                .tag("color")
                .filter(|c| !c.is_empty())
                .map(str::to_owned),
            reply_to: None,
            reply_parent: None,
            notice: Some(ChatNotice {
                notice_type: notice_type(line.tag("msg-id").unwrap_or_default()).to_owned(),
                system_message: line.tag("system-msg").unwrap_or_default().to_owned(),
            }),
            emote_spans: Vec::new(),
        }),
    })
}

/// IRC `msg-id` values spelled the way EventSub's `notice_type` spells
/// them, so these rows render with the live notice styling.
fn notice_type(msg_id: &str) -> &str {
    match msg_id {
        "subgift" | "anonsubgift" => "sub_gift",
        "submysterygift" | "anonsubmysterygift" => "community_sub_gift",
        "giftpaidupgrade" | "anongiftpaidupgrade" => "gift_paid_upgrade",
        "primepaidupgrade" => "prime_paid_upgrade",
        "bitsbadgetier" => "bits_badge_tier",
        "standardpayforward" | "communitypayforward" => "pay_it_forward",
        other => other,
    }
}

/// `/me` messages arrive as CTCP ACTION; live chat carries plain text.
fn strip_action(text: &str) -> &str {
    text.strip_prefix("\u{1}ACTION ")
        .and_then(|t| t.strip_suffix('\u{1}'))
        .unwrap_or(text)
}

/// `badges` lists `set/version`; `badge-info` carries the extra detail by
/// set, such as `subscriber/20` for twenty months subscribed.
fn parse_badges(tag: &str, info: &str) -> Vec<Badge> {
    let infos: Vec<(&str, &str)> = info.split(',').filter_map(|i| i.split_once('/')).collect();
    tag.split(',')
        .filter(|b| !b.is_empty())
        .filter_map(|b| {
            let (set_id, id) = b.split_once('/')?;
            let info = infos
                .iter()
                .find(|(set, _)| *set == set_id)
                .map(|(_, v)| (*v).to_owned())
                .unwrap_or_default();
            Some(Badge {
                set_id: set_id.to_owned(),
                id: id.to_owned(),
                info,
            })
        })
        .collect()
}

/// One IRCv3 line: tags, prefix, command and parameters, with the trailing
/// parameter already unwrapped. Tag values are unescaped per the
/// message-tags spec.
struct IrcLine<'a> {
    tags: Vec<(&'a str, String)>,
    prefix: Option<&'a str>,
    command: &'a str,
    params: Vec<&'a str>,
}

impl<'a> IrcLine<'a> {
    fn parse(line: &'a str) -> Option<Self> {
        let mut rest = line.trim_end_matches(['\r', '\n']);
        let mut tags = Vec::new();
        if let Some(after) = rest.strip_prefix('@') {
            let (raw, tail) = after.split_once(' ')?;
            for tag in raw.split(';').filter(|t| !t.is_empty()) {
                let (key, value) = tag.split_once('=').unwrap_or((tag, ""));
                tags.push((key, unescape_tag(value)));
            }
            rest = tail.trim_start_matches(' ');
        }
        let mut prefix = None;
        if let Some(after) = rest.strip_prefix(':') {
            let (p, tail) = after.split_once(' ')?;
            prefix = Some(p);
            rest = tail.trim_start_matches(' ');
        }
        let mut params = Vec::new();
        let command;
        if let Some((cmd, tail)) = rest.split_once(' ') {
            command = cmd;
            let mut tail = tail.trim_start_matches(' ');
            loop {
                if let Some(trailing) = tail.strip_prefix(':') {
                    params.push(trailing);
                    break;
                }
                match tail.split_once(' ') {
                    Some((p, next)) => {
                        params.push(p);
                        tail = next.trim_start_matches(' ');
                    }
                    None => {
                        if !tail.is_empty() {
                            params.push(tail);
                        }
                        break;
                    }
                }
            }
        } else {
            command = rest;
        }
        if command.is_empty() {
            return None;
        }
        Some(Self {
            tags,
            prefix,
            command,
            params,
        })
    }

    fn tag(&self, key: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    }

    fn nick(&self) -> Option<&'a str> {
        let prefix = self.prefix?;
        Some(prefix.split('!').next().unwrap_or(prefix))
    }

    fn display_name(&self, fallback: &str) -> String {
        match self.tag("display-name") {
            Some(name) if !name.is_empty() => name.to_owned(),
            _ => fallback.to_owned(),
        }
    }

    /// Twitch's send time and the arrival time, in ms. The backlog service
    /// stamps its receive time as `rm-received-ts`; a live line arrives now.
    fn times(&self) -> Option<(i64, i64)> {
        let sent = self.tag("tmi-sent-ts")?.parse().ok()?;
        let received = self
            .tag("rm-received-ts")
            .and_then(|t| t.parse().ok())
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        Some((sent, received))
    }
}

fn unescape_tag(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('\\') => out.push('\\'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIVMSG: &str = "@badge-info=subscriber/20;badges=subscriber/12,moderator/1;color=#1E90FF;display-name=Tricklord;emotes;flags;historical=1;id=dc5e54de-0aa5-4ff0-b66e-7b98eda5060a;mod=1;rm-received-ts=1792981284873;room-id=22484632;subscriber=1;tmi-sent-ts=1792981284715;user-id=54154301;user-type=mod :tricklord!tricklord@tricklord.tmi.twitch.tv PRIVMSG #forsen :You will get a girl? docRant";

    fn message(line: &str, fallback: Option<&str>) -> (UnifiedMessage, bool) {
        match parse_line(line, fallback) {
            Some(IrcItem::Message {
                message, deleted, ..
            }) => (*message, deleted),
            other => panic!("expected a message, got {other:?}"),
        }
    }

    fn event(line: &str) -> ChatEvent {
        match parse_line(line, None) {
            Some(IrcItem::Event(e)) => e,
            other => panic!("expected an event, got {other:?}"),
        }
    }

    #[test]
    fn privmsg_maps_onto_the_live_shape() {
        let (m, deleted) = message(PRIVMSG, None);
        assert_eq!(m.id, "dc5e54de-0aa5-4ff0-b66e-7b98eda5060a");
        assert_eq!(m.username, "tricklord");
        assert_eq!(m.display_name, "Tricklord");
        assert_eq!(m.platform_user_id, "54154301");
        assert_eq!(m.channel_id, "22484632");
        assert_eq!(m.message_text, "You will get a girl? docRant");
        assert_eq!(m.timestamp, 1792981284715);
        assert_eq!(m.arrival_time, 1792981284873);
        assert_eq!(m.effective_ts, 1792981284715);
        assert_eq!(m.color.as_deref(), Some("#1E90FF"));
        assert_eq!(m.badges.len(), 2);
        assert_eq!(m.badges[1].set_id, "moderator");
        assert!(m.is_mod && m.is_subscriber && !m.is_broadcaster);
        assert!(m.notice.is_none());
        assert!(!deleted);
    }

    #[test]
    fn live_line_arrives_now_and_uses_the_fallback_channel() {
        let before = chrono::Utc::now().timestamp_millis();
        let (m, _) = message(
            "@id=m1;tmi-sent-ts=5;user-id=7 :alice!alice@alice.tmi.twitch.tv PRIVMSG #c :hi",
            Some("42"),
        );
        assert_eq!(m.channel_id, "42");
        assert!(m.arrival_time >= before);
        assert_eq!(m.effective_ts, m.arrival_time);
        assert!(parse_line(
            "@id=m1;tmi-sent-ts=5 :alice!alice@alice.tmi.twitch.tv PRIVMSG #c :hi",
            None
        )
        .is_none());
    }

    #[test]
    fn deleted_action_and_reply_tags_are_honoured() {
        let line = "@id=m1;rm-deleted=1;room-id=1;tmi-sent-ts=5;user-id=7;reply-parent-msg-id=p1;reply-parent-user-login=bob;reply-parent-display-name=Bob;reply-parent-msg-body=hi\\sthere\\:;reply-thread-parent-msg-id=root1;color=;display-name= :alice!alice@alice.tmi.twitch.tv PRIVMSG #c :\u{1}ACTION waves\u{1}";
        let (m, deleted) = message(line, None);
        assert!(deleted);
        assert_eq!(m.message_text, "waves");
        assert_eq!(m.display_name, "alice");
        assert_eq!(m.color, None);
        assert_eq!(m.reply_to.as_deref(), Some("p1"));
        let parent = m.reply_parent.as_ref().unwrap();
        assert_eq!(parent.user_login, "bob");
        assert_eq!(parent.user_name, "Bob");
        assert_eq!(parent.body, "hi there;");
        assert_eq!(parent.thread_id, "root1");
    }

    #[test]
    fn usernotice_becomes_a_notice_row() {
        let gift = "@badges=;id=n1;login=giver;display-name=Giver;msg-id=subgift;room-id=1;system-msg=Giver\\sgifted\\sa\\sTier\\s1\\ssub\\sto\\sbob!;tmi-sent-ts=9;user-id=3 :tmi.twitch.tv USERNOTICE #c";
        let resub = "@id=n2;login=sub;msg-id=resub;room-id=1;system-msg=sub\\sresubscribed;tmi-sent-ts=10;user-id=4 :tmi.twitch.tv USERNOTICE #c :pog";
        let (g, _) = message(gift, None);
        let n = g.notice.as_ref().unwrap();
        assert_eq!(n.notice_type, "sub_gift");
        assert_eq!(n.system_message, "Giver gifted a Tier 1 sub to bob!");
        assert_eq!(g.username, "giver");
        assert_eq!(g.message_text, "");
        let (r, _) = message(resub, None);
        assert_eq!(r.message_text, "pog");
        assert_eq!(r.notice.as_ref().unwrap().notice_type, "resub");
    }

    #[test]
    fn moderation_lines_become_events() {
        assert_eq!(
            event("@ban-duration=600;room-id=1;target-user-id=9;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #c :bob"),
            ChatEvent::UserCleared {
                channel_id: "1".into(),
                target_user_id: "9".into(),
                target_user_login: "bob".into(),
                target_user_name: String::new(),
            }
        );
        assert_eq!(
            event("@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #c"),
            ChatEvent::ChatCleared {
                channel_id: "1".into()
            }
        );
        assert_eq!(
            event("@login=bob;room-id=1;target-msg-id=abc;tmi-sent-ts=1 :tmi.twitch.tv CLEARMSG #c :bye"),
            ChatEvent::MessageDeleted {
                channel_id: "1".into(),
                message_id: "abc".into(),
                target_user_id: String::new(),
            }
        );
    }

    #[test]
    fn other_lines_and_garbage_are_skipped() {
        for line in [
            "@room-id=1 :tmi.twitch.tv ROOMSTATE #c",
            "@room-id=1 :tmi.twitch.tv NOTICE #c :nope",
            "PING :tmi.twitch.tv",
            "@room-id=1;tmi-sent-ts=1 :x!x@x.tmi.twitch.tv PRIVMSG #c :no id tag",
            "",
        ] {
            assert!(parse_line(line, Some("1")).is_none(), "{line}");
        }
    }

    #[test]
    fn irc_parser_handles_middle_params_and_unprefixed_trailing() {
        let line = IrcLine::parse("@k=v\\\\x :nick!u@h CMD a  b :c d").unwrap();
        assert_eq!(line.tag("k"), Some("v\\x"));
        assert_eq!(line.nick(), Some("nick"));
        assert_eq!(line.params, ["a", "b", "c d"]);
        let bare = IrcLine::parse("PING").unwrap();
        assert_eq!(bare.command, "PING");
        assert!(bare.params.is_empty());
        assert!(IrcLine::parse("@only=tags").is_none());
    }
}
