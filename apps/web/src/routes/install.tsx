import { Meta, Title } from "@solidjs/meta";
import { RELEASES } from "~/lib/platform";
import "./prose.css";

export default function Install() {
  return (
    <>
      <Title>install - prismoid</Title>
      <Meta
        name="description"
        content="How to install prismoid on Windows, and why Windows shows a warning the first time you run the installer."
      />
      <article class="prose">
        <h1>Installing on Windows</h1>
        <p>
          Three steps: download, get past one Windows warning, sign in. The
          whole thing takes about a minute.
        </p>

        <h2>1. Download</h2>
        <p>
          The download button on the home page gives you{" "}
          <code>Prismoid-Setup-x64.exe</code>, about 14 MB, straight from our
          GitHub release. Your browser downloads it like any other file.
        </p>

        <h2>2. The blue "Windows protected your PC" box</h2>
        <p>
          When you run the installer, Windows shows a blue full-screen box
          saying it prevented an unrecognised app from starting. That is
          Microsoft SmartScreen, and it says nothing about the file being
          unsafe. It appears for any installer that is not signed with a
          publisher certificate Windows has seen many times before, which
          describes every new program from a small developer.
        </p>
        <p>
          prismoid is open source and the installer is built in public on
          GitHub, but it is not code signed yet. Signing certificates are sold
          to companies, and we are applying for the free programme for open
          source projects. Until that is through, the box shows up once per
          install.
        </p>
        <p>To continue:</p>
        <ol>
          <li>
            Click <strong>More info</strong>. It is small text under the
            message, not a button.
          </li>
          <li>
            A <strong>Run anyway</strong> button appears. Click it.
          </li>
        </ol>
        <p>
          If you want to be sure you have the real file, the{" "}
          <a href={`${RELEASES}/latest`}>release page</a> shows a SHA-256 digest
          next to each download. In PowerShell, run{" "}
          <code>Get-FileHash ~\Downloads\Prismoid-Setup-x64.exe</code> and
          compare the two values.
        </p>

        <h2>3. Install and sign in</h2>
        <p>
          The installer puts prismoid in your own user folder, so it never asks
          for administrator rights, and adds a Start Menu entry. When it
          finishes it opens the app, which asks you to sign in with Twitch in
          your browser. prismoid never sees your password; Twitch hands the app
          a token that stays on your machine.
        </p>
        <p>
          Updates arrive on their own. The app checks our release page on launch
          and every six hours, and asks before it installs anything.
        </p>

        <h2>Removing it</h2>
        <p>
          Uninstall from Windows Settings under Apps, like any other program.
          Your chat log and settings stay in{" "}
          <code>%APPDATA%\org.prismoid.app</code> and{" "}
          <code>%LOCALAPPDATA%\org.prismoid.app</code> until you delete those
          folders. The <a href="/privacy">privacy page</a> lists what is in
          them.
        </p>
      </article>
    </>
  );
}
