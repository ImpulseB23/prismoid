import { Meta, Title } from "@solidjs/meta";
import "./prose.css";

export default function Privacy() {
  return (
    <>
      <Title>privacy - prismoid</Title>
      <Meta
        name="description"
        content="What prismoid stores on your computer, which services it talks to, and what this website records."
      />
      <article class="prose">
        <h1>Privacy policy</h1>
        <p>Last updated 1 November 2026.</p>
        <p>
          prismoid is a chat client that runs on your own computer and talks
          directly to the platforms you connect it to. There is no prismoid
          server in between. Nothing you read, type or moderate passes through
          us, and the app has no analytics, telemetry or crash reporting.
        </p>

        <h2>What stays on your computer</h2>
        <ul>
          <li>
            <strong>Sign-in tokens.</strong> Kept in Windows Credential Manager,
            never written to disk as plain text, and only ever sent to the
            platform that issued them.
          </li>
          <li>
            <strong>Chat log.</strong> Messages from channels you open are saved
            to a database in <code>%APPDATA%\org.prismoid.app</code> so a
            channel is not empty when you come back to it. The app keeps the
            newest 10,000 messages per channel and nothing older than 30 days.
            Delete the folder to erase it.
          </li>
          <li>
            <strong>Settings.</strong> Ignored users, highlight phrases, window
            position and the like, in the app's data folders under{" "}
            <code>%APPDATA%</code> and{" "}
            <code>%LOCALAPPDATA%\org.prismoid.app</code>.
          </li>
          <li>
            <strong>Log file.</strong> From version 0.2 the app writes
            connection and error details to{" "}
            <code>%LOCALAPPDATA%\org.prismoid.app\logs</code>. It contains no
            chat text and no tokens, and it only leaves your machine if you
            attach it to a bug report yourself.
          </li>
        </ul>
        <p>
          Uninstalling removes the program. The data folders above are yours to
          delete.
        </p>

        <h2>Who the app talks to</h2>
        <ul>
          <li>
            <strong>Twitch.</strong> Sign-in happens on twitch.tv in your own
            browser; prismoid never sees your password. When you approve, Twitch
            sends your browser to a page on prismoid.org that hands the sign-in
            to the app through a link only the app answers. That page runs
            entirely in your browser; nothing from it reaches a server of ours.
            The app then uses Twitch's API to read chat, send messages and carry
            out moderation on your behalf. It asks Twitch for permission to read
            and send chat, read the channels you follow and moderate, read chat
            settings, moderators, VIPs, blocked terms, unban requests and
            warnings, and to ban, time out, delete messages and change chat
            settings where you are a moderator. You can revoke all of it at any
            time under Connections in your Twitch settings. Twitch's own privacy
            policy applies to what Twitch does with your account.
          </li>
          <li>
            <strong>Google and YouTube.</strong> Only if you connect a YouTube
            account. The app reads and sends live chat through the YouTube Data
            API and stores the token the same way as Twitch's. Revoke it from
            your Google account's connected apps.
          </li>
          <li>
            <strong>7TV, BetterTTV and FrankerFaceZ.</strong> The app asks these
            services for the emote lists of channels you open and loads the
            emote images from their servers. They see your IP address and the
            channel names, nothing about your account.
          </li>
          <li>
            <strong>7TV name paints.</strong> To show the name paints chatters
            picked on 7TV, the app keeps a connection to 7TV for the channels
            you have open, so 7TV can see which channels those are, the same as
            with the 7TV browser extension. Turning off "Show 7TV name paints"
            in Settings closes that connection.
          </li>
          <li>
            <strong>recent-messages.robotty.de.</strong> Twitch sends nothing
            from before you join a channel, so the app fetches the last few
            hundred lines from this community service when you open one. It sees
            your IP address and the channel name. You can turn this off in
            Settings.
          </li>
          <li>
            <strong>api.ivr.fi.</strong> Twitch only tells a channel's owner and
            moderators who is subscribed, so when you open someone's user card
            the app asks this community service, the one Chatterino uses,
            whether they are subscribed to that channel and for how long. It
            sees your IP address, their username and the channel name.
          </li>
          <li>
            <strong>GitHub.</strong> Every six hours the app fetches a small
            version file from our release page to see if an update is available,
            and downloads updates from there. GitHub sees your IP address. The
            request carries no account information.
          </li>
        </ul>
        <p>
          The optional "Follow my browser" setting, off by default, reads the
          address bar of your front browser window through the Windows
          accessibility interface to find out which Twitch channel you are
          looking at. That happens on your machine and is neither stored nor
          sent anywhere.
        </p>

        <h2>This website</h2>
        <p>
          prismoid.org is a static site served by Cloudflare Pages. It sets no
          cookies and runs no analytics. Cloudflare processes requests,
          including your IP address, under its own privacy policy. Download
          buttons send you to GitHub, where the installers are hosted.
        </p>

        <h2>Changes and contact</h2>
        <p>
          Changes to this page are posted here with a new date. Questions go to{" "}
          <a href="https://github.com/ImpulseB23/Prismoid/issues">
            the issue tracker
          </a>{" "}
          or <a href="mailto:security@prismoid.org">security@prismoid.org</a>.
        </p>
      </article>
    </>
  );
}
