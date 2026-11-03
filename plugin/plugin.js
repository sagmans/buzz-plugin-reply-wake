// Reply wake: a prebuilt Buzz plugin (API v1), one self-contained ES module.
//
// Why it exists: Buzz wakes an agent only for a message that tags it, and
// people often forget the tag when they talk to an agent in a thread. Two
// layers close that gap:
//   1. Send-time tag (composer tool): when the user sends an untagged thread
//      message, the tool first adds a real mention of the agent. The message
//      is then an ordinary mention, so Buzz shows typing, activity, Stop and
//      resume as usual.
//   2. Wake fallback (relay listener): a thread message of the user that still
//      went out untagged (for example from the mobile app, which runs no
//      plugins) wakes the agent through ctx.agents.wake. Buzz shows no
//      activity row for plugin wakes, so this layer has no UI feedback.
// Target: the agent whose message the user replies to ("Reply" mode), else
// the last agent that wrote in the thread.
// Only agents that this app runs for the signed-in user are tagged or woken,
// so a message never reaches another person's agent.
//
// Known limitation: Buzz gives composer tools the thread root, not the message
// a draft replies to. Layer 1 therefore finds the "Reply" target by the author
// name the composer shows; layer 2 reads the real parent from the sent tags.

// Cordis starts apply() only after these host services exist.
export const inject = ["react", "pages", "relay", "agents", "conversation"];

// Stream chat messages (NIP-29 kind 9): what thread composers and agents write.
const CHAT_KIND = 9;
const HEX64 = /^[0-9a-f]{64}$/;
// Prefix of the fallback wake text, so the agent knows what woke it.
const WAKE_PREFIX = "OWNER REPLY";
// Thread history read to find the last agent; long threads keep only the newest page.
const THREAD_READ_LIMIT = 500;
// Relay can deliver one event more than once; remember this many handled ids.
const MAX_SEEN = 500;
// Rows kept for the activity page.
const MAX_LOG = 30;
// A read that hangs must not hold work forever.
const READ_TIMEOUT_MS = 10_000;
// Solo chats have their own auto-recipient rules; this plugin must not add a second path there.
const SKIPPED_CHANNEL_TYPES = new Set(["solo"]);
// Host composer text for "Reply" mode (ThreadPanel reply context). If the host changes it,
// Reply mode falls back to layer 2, which reads the real parent from the sent tags.
const REPLYING_TO = "Replying to ";
// IME composition reports this key code; Enter then confirms text, it does not send.
const IME_KEY_CODE = 229;
// Milliseconds in a second, for Buzz's "ms" ordering tag.
const MS_PER_SECOND = 1000;
// Activity rows show this many leading characters of a message id.
const SHORT_ID_LENGTH = 8;
const LOG_PREFIX = "[reply-wake]";
const RULE = Object.freeze({ REPLY: "reply", LAST_AGENT: "last agent" });
const LAYER = Object.freeze({ TAG: "tag", WAKE: "wake" });
const TOOL = Object.freeze({ id: "send-tag", title: "Reply wake" });
const PAGE = Object.freeze({ id: "activity", title: "Reply wake" });

// ---- Shared event helpers -----------------------------------------------------

function channelOf(event) {
  return event.tags.find((t) => t[0] === "h" && t[1])?.[1];
}

// Same rule as Buzz's threadReference: only a NIP-10 "reply" marker makes a reply.
function threadOf(event) {
  let root;
  let reply;
  for (const [name, value, , marker] of event.tags) {
    if (name !== "e" || !value || !HEX64.test(value)) continue;
    if (marker === "root") root = value;
    if (marker === "reply") reply = value;
  }
  return reply ? { root: root ?? reply, parent: reply } : undefined;
}

// Buzz orders messages to the millisecond with its "ms" tag; seconds alone tie often.
function orderKey(event) {
  const ms = Number(event.tags.find((t) => t[0] === "ms")?.[1]);
  return event.created_at * MS_PER_SECOND + (Number.isInteger(ms) && ms >= 0 && ms < MS_PER_SECOND ? ms : 0);
}

// An agent the user can tag or wake: run by this app and owned by the signed-in viewer.
function ownedAgent(agents, pubkey, viewer) {
  const agent = agents.find(pubkey);
  return agent && viewer && agent.owner === viewer ? agent : undefined;
}

function errorText(error) {
  return error?.message ?? String(error);
}

function readEvents(session, filters, signal) {
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
  return session.read(filters, { signal: AbortSignal.any([signal, timeout]) });
}

// Root and replies of one thread, oldest first. `until` bounds it to what came before a message.
async function threadEvents(session, channel, root, signal, until) {
  const events = await readEvents(
    session,
    [
      { ids: [root], limit: 1 },
      {
        kinds: [CHAT_KIND],
        "#e": [root],
        "#h": [channel],
        ...(until === undefined ? {} : { until }),
        limit: THREAD_READ_LIMIT,
      },
    ],
    signal,
  );
  return events
    .filter((e) => e.kind === CHAT_KIND && channelOf(e) === channel && (e.id === root || threadOf(e)?.root === root))
    .sort((a, b) => orderKey(a) - orderKey(b));
}

// In-memory activity log for the page; the host has no plugin storage for it.
function createActivityLog() {
  let rows = Object.freeze([]);
  const listeners = new Set();
  return {
    record(entry) {
      rows = Object.freeze([{ at: Date.now(), ...entry }, ...rows].slice(0, MAX_LOG));
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => rows,
  };
}

// True the first time an id is seen. Set keeps insertion order, so the oldest id is dropped first.
function createSeenOnce(max) {
  const seen = new Set();
  return (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > max) seen.delete(seen.values().next().value);
    return true;
  };
}

// ---- Layer 1: send-time tag ---------------------------------------------------

// The author name the composer shows in "Reply" mode, or undefined outside it.
function replyingToName(form) {
  const replying = [...form.querySelectorAll("span")].find((s) => s.textContent?.startsWith(REPLYING_TO));
  return replying ? replying.textContent.slice(REPLYING_TO.length).trim() : undefined;
}

// Whom the untagged message is for, or nothing when unsure.
function pickComposerTarget(agentsHere, replyName) {
  if (!agentsHere.length) return undefined;
  if (replyName !== undefined) {
    // "Reply" mode: the shown author name must match exactly one agent of this thread.
    const matches = agentsHere.filter((a) => a.name === replyName);
    return matches.length === 1 ? { ...matches[0], rule: RULE.REPLY } : undefined;
  }
  const last = agentsHere.reduce((a, b) => (b.key > a.key ? b : a));
  return { ...last, rule: RULE.LAST_AGENT };
}

// A plain Enter in this form's editor that the host treats as "send".
function isSendKey(event, form) {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.repeat || event.isComposing || event.keyCode === IME_KEY_CODE || event.defaultPrevented) return false;
  const editor = event.target?.closest?.('[contenteditable="true"]');
  if (!editor || !form.contains(editor)) return false;
  // Enter picks from an open completion list there; it does not send.
  return !(editor.hasAttribute("aria-activedescendant") || form.querySelector('[role="listbox"]'));
}

// Owned agents seen in this thread: pubkey -> { key: order, name }. Newest wins "last agent".
function useThreadAgents(React, { relay, agents, log }, { scope, channelId, threadRootId, audience }) {
  const thread = React.useRef(new Map());
  React.useEffect(() => {
    // Thread composers only; Solo chats (audience) and channel top level keep Buzz's own rules.
    if (!threadRootId || audience || !HEX64.test(threadRootId)) return undefined;
    const snap = relay.snapshot();
    // The composer must belong to the live session, else its thread is another community's.
    if (snap.status !== "ready" || !snap.session || snap.session.scope !== scope) return undefined;
    const { session, viewer } = snap;
    const seenAgents = new Map();
    thread.current = seenAgents;
    const consider = (event) => {
      const agent = ownedAgent(agents, event.pubkey, viewer);
      if (!agent) return;
      const key = orderKey(event);
      if ((seenAgents.get(agent.pubkey)?.key ?? -1) < key) seenAgents.set(agent.pubkey, { key, name: agent.name });
    };
    const controller = new AbortController();
    threadEvents(session, channelId, threadRootId, controller.signal)
      .then((events) => events.forEach(consider))
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.warn(`${LOG_PREFIX} thread read failed`, { channelId, threadRootId, error });
        log.record({ layer: LAYER.TAG, agent: "?", message: threadRootId, status: `read failed: ${errorText(error)}` });
      });
    const stopLive = session.subscribeLive((batch) => {
      for (const event of batch.events) {
        if (event.kind === CHAT_KIND && channelOf(event) === channelId && threadOf(event)?.root === threadRootId) consider(event);
      }
    });
    return () => {
      controller.abort();
      stopLive();
    };
  }, [scope, channelId, threadRootId, audience]);
  return thread;
}

// Runs before the host's own Enter and submit handlers (capture phase on the form),
// so the mention is in the draft when the host reads it to send.
function useBeforeSend(React, anchor, beforeSend) {
  React.useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return undefined;
    const onKeyDown = (event) => {
      if (isSendKey(event, form)) beforeSend(form);
    };
    const onSubmit = () => beforeSend(form);
    form.addEventListener("keydown", onKeyDown, true);
    form.addEventListener("submit", onSubmit, true);
    return () => {
      form.removeEventListener("keydown", onKeyDown, true);
      form.removeEventListener("submit", onSubmit, true);
    };
  }, []);
}

// Rendered by the host in every composer; it shows nothing and only acts at send.
function createSendTag(deps) {
  const { react: React, log } = deps;
  return function SendTag(props) {
    // Latest props for DOM listeners, which must not act on a stale draft.
    const latest = React.useRef(props);
    latest.current = props;
    const anchor = React.useRef(null);
    const thread = useThreadAgents(React, deps, props);
    useBeforeSend(React, anchor, (form) => {
      const p = latest.current;
      if (!p.threadRootId || p.audience || p.disabled || p.recipients.length) return;
      if (form.hasAttribute("data-editing")) return;
      const agentsHere = [...thread.current.entries()].map(([pubkey, a]) => ({ pubkey, ...a }));
      const target = pickComposerTarget(agentsHere, replyingToName(form));
      if (!target) return;
      if (p.replaceRecipients([{ pubkey: target.pubkey, name: target.name }]))
        log.record({ layer: LAYER.TAG, agent: target.name, message: p.threadRootId, status: `tagged (${target.rule})` });
    });
    return React.createElement("span", { ref: anchor, hidden: true });
  };
}

// ---- Layer 2: wake fallback ---------------------------------------------------

// "Reply" on a message: its author is the one addressed, agent or not.
async function parentTarget({ agents, snap, thread, channel, signal }) {
  const events = await readEvents(snap.session, [{ ids: [thread.parent], limit: 1 }], signal);
  const parent = events.find((e) => e.id === thread.parent);
  if (!parent) return { reason: "replied message not found" };
  if (channelOf(parent) !== channel) return { reason: "replied message is in another channel" };
  const agent = ownedAgent(agents, parent.pubkey, snap.viewer);
  return agent ? { agent, rule: RULE.REPLY } : { reason: "replied message is not by your agent" };
}

// Plain thread message: the newest earlier message by one of the user's agents wins.
async function lastAgentTarget({ agents, snap, message, thread, channel, signal }) {
  const events = await threadEvents(snap.session, channel, thread.root, signal, message.created_at);
  const mine = orderKey(message);
  for (const event of events.reverse()) {
    if (event.id === message.id || orderKey(event) > mine) continue;
    const agent = ownedAgent(agents, event.pubkey, snap.viewer);
    if (agent) return { agent, rule: RULE.LAST_AGENT };
  }
  return { reason: "no agent of yours in this thread" };
}

function wakeText(viewer, rule, message) {
  return (
    `${WAKE_PREFIX}: your owner (${viewer}) replied in this thread without tagging you. ` +
    `You were picked by the "${rule}" rule of the reply-wake plugin. ` +
    `Owner message ${message.id}; its author was checked by the plugin. ` +
    `Message text: ${JSON.stringify(message.content)}`
  );
}

// Why a live event is not a candidate for the fallback, or undefined when it is.
function wakeSkipReason(snap, thread, channel) {
  if (!thread) return "not a thread reply";
  if (!channel) return "no channel tag";
  const channelInfo = snap.session.channels.get?.(channel);
  return SKIPPED_CHANNEL_TYPES.has(channelInfo?.channelType) ? "solo chat" : undefined;
}

function createWakeHandler({ agents, log }) {
  const firstTime = createSeenOnce(MAX_SEEN);
  return async function handle(snap, message, signal) {
    if (message.kind !== CHAT_KIND) return;
    // Only the signed-in user's own messages; agents' and others' messages never wake anyone here.
    if (!snap.viewer || message.pubkey !== snap.viewer) return;
    if (!firstTime(message.id)) return;
    // A tagged message already wakes whom it names (layer 1 makes most messages tagged).
    if (message.tags.some((t) => t[0] === "p")) return;
    const skip = (reason) => log.record({ layer: LAYER.WAKE, agent: "-", message: message.id, status: `skipped: ${reason}` });
    const thread = threadOf(message);
    const channel = channelOf(message);
    const reason = wakeSkipReason(snap, thread, channel);
    if (reason) return skip(reason);

    const input = { agents, snap, message, thread, channel, signal };
    const found = thread.parent !== thread.root ? await parentTarget(input) : await lastAgentTarget(input);
    if (!found.agent) return skip(found.reason);

    try {
      agents.wake(found.agent.key, { channel, root: thread.root, text: wakeText(snap.viewer, found.rule, message) });
      log.record({ layer: LAYER.WAKE, agent: found.agent.name, message: message.id, status: `woken (${found.rule})` });
    } catch (error) {
      // Throws when this app does not run the agent, or its queue is full.
      console.warn(`${LOG_PREFIX} wake failed`, { agent: found.agent.pubkey, message: message.id, error });
      log.record({ layer: LAYER.WAKE, agent: found.agent.name, message: message.id, status: `not woken: ${errorText(error)}` });
    }
  };
}

// Follow the relay session: a reconnect replaces the session, so listen again on the new one.
function followRelay({ relay, log, handle }) {
  let current;
  let stopLive;
  let controller;
  function attach() {
    const snap = relay.snapshot();
    if (snap.status !== "ready" || snap.session === current) return;
    stopLive?.();
    controller?.abort();
    current = snap.session;
    log.record({ layer: LAYER.WAKE, agent: "-", message: "-", status: `listening (generation ${snap.generation})` });
    controller = new AbortController();
    const signal = controller.signal;
    // Live events only, never replays: an old message must not wake an agent again.
    stopLive = snap.session.subscribeLive((batch) => {
      if (batch.replay) return;
      for (const event of batch.events) {
        handle(snap, event, signal).catch((error) => {
          if (signal.aborted) return;
          console.warn(`${LOG_PREFIX} message not handled`, { message: event.id, error });
          log.record({ layer: LAYER.WAKE, agent: "?", message: event.id, status: `error: ${errorText(error)}` });
        });
      }
    });
  }
  attach();
  const stopRelay = relay.subscribe(attach);
  return () => {
    stopRelay();
    stopLive?.();
    controller?.abort();
  };
}

// ---- Activity page --------------------------------------------------------------

// No console access from an agent's side, so each tag, wake and skip is shown here with its reason.
function createActivityPage({ react: React, log }) {
  const h = React.createElement;
  return function ActivityPage() {
    const rows = React.useSyncExternalStore(log.subscribe, log.snapshot);
    return h(
      "section",
      { className: "ui-card", style: { padding: "var(--space-panel-inset)", overflow: "auto" } },
      h("h1", null, PAGE.title),
      h("p", null, "tag = mention added at send (full Buzz UI). wake = fallback for a message sent untagged (no UI). Log resets on restart."),
      rows.length === 0
        ? h("p", null, "Nothing since start.")
        : h(
            "ul",
            null,
            rows.map((r, i) =>
              h(
                "li",
                { key: `${r.at}-${i}` },
                `${new Date(r.at).toLocaleTimeString()} · ${r.layer} · ${r.agent} · ${String(r.message).slice(0, SHORT_ID_LENGTH)} · ${r.status}`,
              ),
            ),
          ),
    );
  };
}

export function apply(ctx) {
  const deps = { react: ctx.react, relay: ctx.relay, agents: ctx.agents, log: createActivityLog() };
  ctx.conversation.registerTool({ ...TOOL, component: createSendTag(deps) });
  const handle = createWakeHandler(deps);
  ctx.effect(() => followRelay({ ...deps, handle }));
  // Debug log only, so it stays out of the sidebar; a plugin link still opens it when needed.
  ctx.pages.register({ ...PAGE, primary: false, component: createActivityPage(deps) });
}
