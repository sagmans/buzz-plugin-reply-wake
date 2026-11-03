# buzz-plugin-reply-wake

A Buzz desktop plugin. When you send a thread message without a tag, it
still reaches your agent: the agent you reply to, else the last agent in
the thread.

## What it does

Buzz wakes an agent only for a message that tags it. In a long thread with
an agent, it is easy to forget the tag. The plugin closes that gap with two
layers.

| Layer | When | Result |
| --- | --- | --- |
| Tag at send | You send an untagged thread message from the desktop composer | The plugin adds a real mention of the target agent before Buzz sends. Buzz then shows typing, activity, Stop and resume as for any mention. |
| Wake fallback | A thread message of yours still goes out untagged (for example from the mobile app) | The plugin wakes the target agent through the Buzz agents service. Buzz shows no activity row for this wake. |

The target agent comes from the target rule in the settings. The default
rule is "Replied agent, else last agent":

- You click **Reply** on a message of one of your agents: that agent.
- You write a plain thread message: the last of your agents that wrote in
  the thread.

The plugin only tags or wakes agents that this copy of the app runs for the
signed-in user. Messages of other people and of agents never trigger it.
Solo chats and channel top-level messages keep the normal Buzz rules.

A wake from the fallback gives the agent this text, framed by Buzz as data:

```text
OWNER REPLY: your owner (<pubkey>) replied in this thread without tagging
you. You were picked by the "<rule>" rule of the reply-wake plugin. ...
```

An agent acts on it only when its own instructions say so. Add a rule such
as "Treat an `OWNER REPLY` wake as a message from your owner" to the agent
instructions if you use the fallback.

## Install

The plugin needs the Buzz desktop app (plugin API version 1). The built
plugin is in the `plugin/` folder: `manifest.json` and `plugin.js`. There is
no build step.

From Git:

1. Open **Settings > Plugins > Manage plugins**.
2. Add the repository `sagmans/buzz-plugin-reply-wake` with branch `main`.
3. Select the `plugin` folder in the list, then select **Install**.

On macOS, this link opens the same preview. It does not install anything
until you select **Install**:

```sh
open 'buzz://plugin-install?repository=sagmans%2Fbuzz-plugin-reply-wake&ref=main'
```

From a folder:

1. Clone this repository.
2. Open **Settings > Plugins > Manage plugins** and load a folder.
3. Select the `plugin/` folder of the clone, then select **Install**.

New plugins are enabled by default. To update, use **Update** on the plugin
in **Manage plugins**.

## Settings

Open **Settings > Plugins > Reply wake**. Each change is saved at once and
applies to the next message. The settings are kept on this device only, in
the app's local storage under the key `sagmans.reply-wake.settings.v1`.

| Setting | Default | Values | Effect |
| --- | --- | --- | --- |
| Add the tag at send | On | On, Off | Turns the tag-at-send layer on or off. |
| Wake fallback | On | On, Off | Turns the wake-fallback layer on or off. |
| Target agent | Replied agent, else last agent | See below | Selects the target agent of both layers. |

| Target rule | Saved value | Reply to an agent's message | Plain thread message |
| --- | --- | --- | --- |
| Replied agent, else last agent | `reply-then-last` | That agent | Last agent |
| Replied agent only | `reply-only` | That agent | No tag, no wake |
| Last agent only | `last-only` | Last agent | Last agent |

The plugin checks each change before it saves it. If the saved value is
damaged, each bad part falls back to its default and the card shows why.
**Restore defaults** removes the saved value.

## Mobile behavior

The Buzz mobile app runs no plugins. A thread message that you send from
mobile has no tag at send, so only the wake fallback can deliver it:

- The desktop app that runs your agents must be open and signed in.
- **Wake fallback** must be on. The target rule applies as on desktop.
- The desktop app shows no "working" row for this wake. The mobile thread
  view shows the agent typing when the agent answers.

## Activity page

The plugin has a page, **Reply wake**, that lists the last 30 tags, wakes
and skips with a reason for each. It has no sidebar entry. Use it when an
agent did not answer:

- Search for "Reply wake" in the app, or
- open the link `buzz://plugin?id=sagmans.reply-wake&page=activity`.

The list resets when the app restarts.

## Limitations

- Buzz gives composer tools the thread, not the message that a draft replies
  to. In Reply mode, the tag-at-send layer finds the agent by the author
  name that the composer shows ("Replying to ..."). If two agents in the
  thread have the same name, or the host text changes, no tag is added.
  The wake fallback then reads the real reply target from the sent message.
- To find the last agent, the plugin reads the newest 500 messages of the
  thread.
- A wake can fail when the agent queue is full or this app does not run the
  agent. The activity page shows the failure.

## Security

- Buzz plugins are not sandboxed. They run inside the app with its full
  access. Install only code that you trust, and read `plugin/plugin.js`
  first. It is one file with no dependencies.
- The plugin asks for no native host access: the manifest has no `host`
  block. It uses these app services: React, pages, relay, agents,
  conversation and settings cards.
- It acts only on your own messages, and only for your own agents that this
  app runs. It does not send messages for you. It adds a mention to your
  draft, or it wakes your agent with your message text as data.
- The settings hold no secrets. They contain only the three values above.

## Contributing

1. After you clone, run `scripts/setup-hooks` once. It turns on the Git
   hooks of this repository.
2. Install the tools that the hooks use: `gitleaks`, `node`, `shellcheck`,
   `shfmt`, `markdownlint-cli2`, `lizard`, `semgrep` and `trivy`.
3. Run `scripts/check` before you push. It runs the smoke scenarios
   (`node scripts/smoke.mjs`), the linters and the scanners.
4. Sign each commit and add a sign-off: `git commit -s -S`. The commit
   message rules are in `.githooks/GIT_CONVENTION.md`.

All checks must pass before you push. Never use `--no-verify`.

## License

Apache License 2.0. See [LICENSE](LICENSE).
