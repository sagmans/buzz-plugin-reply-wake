#!/usr/bin/env node
// Smoke scenarios: drive the real plugin.js with a fake Buzz context in Node.
//
// Why: the plugin runs inside the Buzz desktop app, which has no headless test
// mode. This script stands in for the host services the plugin injects
// (React, relay, agents, conversation, pages, settings cards) so the user
// journeys the README promises are checked on every push:
//   - send-time tag: plain thread message, Reply to an agent's message,
//     already-tagged message left alone, keys that must not send;
//   - wake fallback: untagged message from another client (mobile), replies,
//     replays, duplicates, Solo chats, failed wakes;
//   - settings: defaults, each target rule, layer switches, invalid saved
//     values, and changes made through the settings card.
// Scenarios that need the settings card run only when the plugin registers
// one, so the same script can compare an older build that has no settings.
//
// Usage: node scripts/smoke.mjs [path/to/plugin.js]   (default: plugin/plugin.js)

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PLUGIN = "plugin/plugin.js";
// Must match the plugin's storage key: settings are device-local by design.
const SETTINGS_KEY = "sagmans.reply-wake.settings.v1";
const WAKE_PREFIX = "OWNER REPLY";
const CHAT_KIND = 9;
// Event loop turns to wait for the plugin's async relay reads to settle.
const SETTLE_TURNS = 5;
const SCOPE = "community-test";
const CHANNEL = "channel-main";
const SOLO_CHANNEL = "channel-solo";

// Deterministic 64-hex ids and pubkeys, derived at run time so no real-looking
// key is ever written into the repository.
const hex = (label) => createHash("sha256").update(`reply-wake-smoke:${label}`).digest("hex");
const USER = hex("user");
const OTHER_PERSON = hex("other-person");
const AGENTS = {
  alpha: { pubkey: hex("alpha"), name: "Alpha", owner: USER },
  beta: { pubkey: hex("beta"), name: "Beta", owner: USER },
  // An agent of another person: never tagged or woken for the user.
  xeno: { pubkey: hex("xeno"), name: "Xeno", owner: OTHER_PERSON },
};
for (const agent of Object.values(AGENTS)) agent.key = agent.pubkey;

class SmokeFailure extends Error {
  constructor(scenario, message, details) {
    const suffix = details === undefined ? "" : ` -- ${JSON.stringify(details)}`;
    super(`${scenario}: ${message}${suffix}`);
    this.name = "SmokeFailure";
  }
}

// ---- Fake React: just enough hooks to run function components -------------------

function createReact() {
  let current = null;
  const slot = (init) => {
    const index = current.cursor++;
    if (!(index in current.hooks)) current.hooks[index] = init();
    return current.hooks[index];
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useRef: (initial) => slot(() => ({ current: initial })),
    useState(initial) {
      const instance = current;
      const state = slot(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [state.value, (next) => ((state.value = typeof next === "function" ? next(state.value) : next), instance.render())];
    },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useSyncExternalStore(subscribe, getSnapshot) {
      const instance = current;
      slot(() => ({ cleanup: subscribe(() => instance.render()) }));
      return getSnapshot();
    },
    useEffect(effect, deps) {
      const instance = current;
      const state = slot(() => ({ deps: undefined, cleanup: undefined, ran: false }));
      const changed = !state.ran || !deps || deps.some((d, i) => !Object.is(d, state.deps[i]));
      if (!changed) return;
      instance.pending.push(() => {
        state.cleanup?.();
        const cleanup = effect();
        Object.assign(state, { deps, ran: true, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
  // Mount a component; `attach` gives each element with a ref its fake DOM node.
  React.mount = (Component, props, attach = () => null) => {
    const instance = { hooks: [], pending: [], cursor: 0, props, tree: null };
    instance.render = () => {
      instance.cursor = 0;
      current = instance;
      try {
        instance.tree = Component(instance.props);
      } finally {
        current = null;
      }
      walk(instance.tree, (node) => node.props.ref && (node.props.ref.current = attach(node)));
      const pending = instance.pending.splice(0);
      pending.forEach((run) => run());
      return instance.tree;
    };
    instance.update = (next) => ((instance.props = next), instance.render());
    instance.unmount = () => instance.hooks.forEach((hook) => hook?.cleanup?.());
    instance.render();
    return instance;
  };
  return React;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node.props) visit(node);
  (node.children ?? []).forEach((child) => walk(child, visit));
}

function findByName(tree, name) {
  let found;
  walk(tree, (node) => (found ??= node.props.name === name ? node : undefined));
  return found;
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node !== "object") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return (node.children ?? []).map(textOf).join(" ");
}

// ---- Fake composer DOM ------------------------------------------------------------

function createForm({ replyingTo, editing = false } = {}) {
  const listeners = { keydown: new Set(), submit: new Set() };
  const editor = {
    closest: (selector) => (selector === '[contenteditable="true"]' ? editor : null),
    hasAttribute: () => false,
  };
  const spans = replyingTo === undefined ? [] : [{ textContent: `Replying to ${replyingTo}` }];
  const form = {
    editor,
    closest: (selector) => (selector === "form" ? form : null),
    querySelectorAll: (selector) => (selector === "span" ? spans : []),
    querySelector: () => null,
    hasAttribute: (name) => name === "data-editing" && editing,
    contains: (node) => node === editor,
    addEventListener: (type, listener) => listeners[type].add(listener),
    removeEventListener: (type, listener) => listeners[type].delete(listener),
    listenerCount: () => listeners.keydown.size + listeners.submit.size,
    pressEnter: (keys = {}) => listeners.keydown.forEach((l) => l({ key: "Enter", target: editor, keyCode: 13, ...keys })),
    submit: () => listeners.submit.forEach((l) => l({})),
  };
  return form;
}

// ---- Fake relay, agents and host services --------------------------------------------

function event({ id, pubkey, at, content = "", channel = CHANNEL, root, parent, mentions = [] }) {
  const tags = [["h", channel]];
  if (root) tags.push(["e", root, "", "root"], ["e", parent ?? root, "", "reply"]);
  mentions.forEach((p) => tags.push(["p", p]));
  return { id: hex(id), kind: CHAT_KIND, pubkey, created_at: at, content, tags };
}

function matches(filter, e) {
  if (filter.ids && !filter.ids.includes(e.id)) return false;
  if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
  if (filter.until !== undefined && e.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    if (!e.tags.some((t) => t[0] === key.slice(1) && values.includes(t[1]))) return false;
  }
  return true;
}

// A thread in the main channel: the user's root, then two of the user's agents,
// another person, and another person's agent (newest).
function threadFixture() {
  const root = event({ id: "root", pubkey: USER, at: 100, content: "Plan the release" });
  const R = root.id;
  const events = [
    root,
    event({ id: "alpha-1", pubkey: AGENTS.alpha.pubkey, at: 110, root: R, content: "Draft ready" }),
    event({ id: "beta-1", pubkey: AGENTS.beta.pubkey, at: 120, root: R, content: "Tests pass" }),
    event({ id: "person-1", pubkey: OTHER_PERSON, at: 125, root: R, content: "Looks fine" }),
    event({ id: "xeno-1", pubkey: AGENTS.xeno.pubkey, at: 130, root: R, content: "Not yours" }),
  ];
  return { root: R, events, byId: (name) => hex(name) };
}

function createHost(fixture, { wakeThrows = false, storage } = {}) {
  const liveListeners = new Set();
  const relayListeners = new Set();
  const session = {
    scope: SCOPE,
    channels: new Map([
      [CHANNEL, { channelType: "stream" }],
      [SOLO_CHANNEL, { channelType: "solo" }],
    ]),
    async read(filters, { signal } = {}) {
      if (signal?.aborted) throw signal.reason;
      const found = new Map();
      for (const filter of filters) {
        const hits = fixture.events.filter((e) => matches(filter, e)).sort((a, b) => b.created_at - a.created_at);
        hits.slice(0, filter.limit ?? hits.length).forEach((e) => found.set(e.id, e));
      }
      return [...found.values()];
    },
    subscribeLive(listener) {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
  };
  const snap = { status: "ready", session, viewer: USER, generation: 1 };
  const wakes = [];
  const registered = { tools: [], pages: [], cards: [], effects: [] };
  const ctx = {
    relay: { snapshot: () => snap, subscribe: (l) => (relayListeners.add(l), () => relayListeners.delete(l)) },
    agents: {
      find: (pubkey) => Object.values(AGENTS).find((a) => a.pubkey === pubkey),
      wake(key, wake) {
        if (wakeThrows) throw new Error("agent queue is full");
        wakes.push({ key, ...wake });
      },
    },
    conversation: { registerTool: (tool) => registered.tools.push(tool) },
    pages: { register: (page) => registered.pages.push(page) },
    settingsCards: { register: (card) => registered.cards.push(card) },
    effect: (fn) => registered.effects.push(fn()),
  };
  const live = (events, replay = false) => liveListeners.forEach((l) => l({ events, replay }));
  return { ctx, wakes, registered, live, storage };
}

function createStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[SETTINGS_KEY, initial]]);
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    raw: () => values.get(SETTINGS_KEY),
  };
}

const settle = async () => {
  for (let i = 0; i < SETTLE_TURNS; i += 1) await new Promise((r) => setImmediate(r));
};

// ---- Harness ----------------------------------------------------------------------------

async function startPlugin(plugin, { stored, wakeThrows } = {}) {
  const storage = createStorage(stored);
  globalThis.localStorage = storage;
  const fixture = threadFixture();
  const React = createReact();
  const host = createHost(fixture, { wakeThrows, storage });
  host.ctx.react = React;
  plugin.apply(host.ctx);
  return { ...host, fixture, React, storage };
}

// Mount the send-time tool in a thread composer and return what it did at send.
async function composer(run, { replyingTo, recipients = [], threadRootId = run.fixture.root, ...props } = {}) {
  const form = createForm({ replyingTo, editing: props.editing });
  const replaced = [];
  const tool = run.registered.tools[0];
  const toolProps = {
    scope: SCOPE,
    channelId: CHANNEL,
    threadRootId,
    disabled: false,
    recipients,
    replaceRecipients: (list) => (replaced.push(list), true),
    ...props,
  };
  const view = run.React.mount(tool.component, toolProps, () => ({ closest: (s) => (s === "form" ? form : null) }));
  await settle();
  return { form, replaced, view };
}

const results = [];
async function scenario(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function expect(name, condition, message, details) {
  if (!condition) throw new SmokeFailure(name, message, details);
}

function expectTag(name, replaced, agent) {
  expect(name, replaced.length === 1, "expected exactly one tag at send", replaced);
  expect(name, replaced[0][0]?.pubkey === agent.pubkey && replaced[0][0]?.name === agent.name, `expected ${agent.name}`, replaced);
}

function expectWake(name, wakes, agent, rule, root) {
  expect(name, wakes.length === 1, "expected exactly one wake", wakes);
  const [wake] = wakes;
  expect(name, wake.key === agent.key && wake.channel === CHANNEL && wake.root === root, `expected a wake of ${agent.name}`, wake);
  expect(name, wake.text.startsWith(`${WAKE_PREFIX}:`) && wake.text.includes(`"${rule}" rule`), "unexpected wake text", wake.text);
}

// ---- Scenarios: send-time tag (layer 1) ----------------------------------------------------

async function sendTagScenarios(plugin) {
  await scenario("tag: plain thread message tags the last agent of the user", async () => {
    const run = await startPlugin(plugin);
    const { form, replaced } = await composer(run);
    form.pressEnter();
    expectTag("plain", replaced, AGENTS.beta);
  });
  await scenario("tag: Reply to an agent's message tags that agent", async () => {
    const run = await startPlugin(plugin);
    const { form, replaced } = await composer(run, { replyingTo: AGENTS.alpha.name });
    form.pressEnter();
    expectTag("reply", replaced, AGENTS.alpha);
  });
  await scenario("tag: Reply to a person's message adds no tag", async () => {
    const run = await startPlugin(plugin);
    const { form, replaced } = await composer(run, { replyingTo: "Olga" });
    form.pressEnter();
    expect("reply-person", replaced.length === 0, "no tag expected", replaced);
  });
  await scenario("tag: already-tagged message is left unchanged", async () => {
    const run = await startPlugin(plugin);
    const { form, replaced } = await composer(run, { recipients: [{ pubkey: AGENTS.alpha.pubkey, name: AGENTS.alpha.name }] });
    form.pressEnter();
    form.submit();
    expect("tagged", replaced.length === 0, "a tagged draft must not change", replaced);
  });
  await scenario("tag: submit button path (capture phase) tags too", async () => {
    const run = await startPlugin(plugin);
    const { form, replaced } = await composer(run);
    form.submit();
    expectTag("submit", replaced, AGENTS.beta);
  });
  await scenario("tag: Shift+Enter, IME Enter, edit mode and disabled composer add no tag", async () => {
    const run = await startPlugin(plugin);
    const plain = await composer(run);
    plain.form.pressEnter({ shiftKey: true });
    plain.form.pressEnter({ isComposing: true });
    plain.form.pressEnter({ keyCode: 229 });
    const editing = await composer(run, { editing: true });
    editing.form.pressEnter();
    const disabled = await composer(run, { disabled: true });
    disabled.form.pressEnter();
    const all = [...plain.replaced, ...editing.replaced, ...disabled.replaced];
    expect("keys", all.length === 0, "no tag expected", all);
  });
  await scenario("tag: a live agent message becomes the new last agent", async () => {
    const run = await startPlugin(plugin);
    const { form, replaced } = await composer(run);
    run.live([event({ id: "alpha-2", pubkey: AGENTS.alpha.pubkey, at: 140, root: run.fixture.root })]);
    form.pressEnter();
    expectTag("live", replaced, AGENTS.alpha);
  });
  await scenario("tag: channel top level and unmount leave the composer alone", async () => {
    const run = await startPlugin(plugin);
    const top = await composer(run, { threadRootId: null });
    top.form.pressEnter();
    expect("top", top.replaced.length === 0, "top-level composer must not be tagged", top.replaced);
    const thread = await composer(run);
    thread.view.unmount();
    expect("unmount", thread.form.listenerCount() === 0, "listeners must be removed on unmount");
  });
}

// ---- Scenarios: wake fallback (layer 2) ---------------------------------------------------------

// An untagged message of the user as another client (for example mobile) sends it.
function userMessage(run, { id, at = 150, parent, channel = CHANNEL, mentions, root = run.fixture.root, pubkey = USER }) {
  return event({ id, pubkey, at, channel, root, parent, mentions, content: "please continue" });
}

async function wakeScenarios(plugin) {
  await scenario("wake: untagged thread message wakes the last agent of the user", async () => {
    const run = await startPlugin(plugin);
    run.live([userMessage(run, { id: "u-plain" })]);
    await settle();
    expectWake("wake-plain", run.wakes, AGENTS.beta, "last agent", run.fixture.root);
  });
  await scenario("wake: untagged Reply to an agent's message wakes that agent", async () => {
    const run = await startPlugin(plugin);
    run.live([userMessage(run, { id: "u-reply", parent: run.fixture.byId("alpha-1") })]);
    await settle();
    expectWake("wake-reply", run.wakes, AGENTS.alpha, "reply", run.fixture.root);
  });
  await scenario("wake: Reply to a person's or another owner's agent message wakes nobody", async () => {
    const run = await startPlugin(plugin);
    run.live([userMessage(run, { id: "u-person", parent: run.fixture.byId("person-1") })]);
    run.live([userMessage(run, { id: "u-xeno", parent: run.fixture.byId("xeno-1") })]);
    await settle();
    expect("wake-person", run.wakes.length === 0, "no wake expected", run.wakes);
  });
  await scenario("wake: tagged message, replay, duplicate and agent-authored message wake nobody extra", async () => {
    const run = await startPlugin(plugin);
    run.live([userMessage(run, { id: "u-tagged", mentions: [AGENTS.alpha.pubkey] })]);
    run.live([userMessage(run, { id: "u-replay" })], true);
    run.live([userMessage(run, { id: "u-agent", pubkey: AGENTS.alpha.pubkey })]);
    const once = userMessage(run, { id: "u-once" });
    run.live([once]);
    run.live([once]);
    await settle();
    expectWake("wake-filters", run.wakes, AGENTS.beta, "last agent", run.fixture.root);
  });
  await scenario("wake: Solo chat and channel top level are skipped", async () => {
    const run = await startPlugin(plugin);
    run.live([userMessage(run, { id: "u-solo", channel: SOLO_CHANNEL })]);
    run.live([userMessage(run, { id: "u-top", root: null })]);
    await settle();
    expect("wake-skip", run.wakes.length === 0, "no wake expected", run.wakes);
  });
  await scenario("wake: a failed wake is logged on the activity page, not thrown", async () => {
    const run = await startPlugin(plugin, { wakeThrows: true });
    run.live([userMessage(run, { id: "u-fail" })]);
    await settle();
    const page = run.React.mount(run.registered.pages[0].component, {});
    expect("wake-fail", textOf(page.tree).includes("not woken: agent queue is full"), "activity page must show the failure", textOf(page.tree));
  });
}

// ---- Scenarios: settings ---------------------------------------------------------------------------

async function settingsScenarios(plugin) {
  await scenario("settings: the card shows today's behavior as the default", async () => {
    const run = await startPlugin(plugin);
    expect("defaults", run.registered.cards.length === 1, "one settings card expected", run.registered.cards);
    const card = run.React.mount(run.registered.cards[0].component, { active: () => true });
    expect("defaults", findByName(card.tree, "sendTag")?.props.checked === true, "send-time tag must default on");
    expect("defaults", findByName(card.tree, "wakeFallback")?.props.checked === true, "wake fallback must default on");
    expect("defaults", findByName(card.tree, "targetRule")?.props.value === "reply-then-last", "rule must default to reply-then-last");
  });
  await scenario("settings: reply-only ignores plain thread messages", async () => {
    const run = await startPlugin(plugin, { stored: JSON.stringify({ targetRule: "reply-only" }) });
    const plain = await composer(run);
    plain.form.pressEnter();
    const reply = await composer(run, { replyingTo: AGENTS.alpha.name });
    reply.form.pressEnter();
    expect("reply-only", plain.replaced.length === 0, "plain message must not be tagged", plain.replaced);
    expectTag("reply-only", reply.replaced, AGENTS.alpha);
    run.live([userMessage(run, { id: "s-plain" })]);
    run.live([userMessage(run, { id: "s-reply", parent: run.fixture.byId("alpha-1") })]);
    await settle();
    expectWake("reply-only", run.wakes, AGENTS.alpha, "reply", run.fixture.root);
  });
  await scenario("settings: last-only targets the last agent even in Reply mode", async () => {
    const run = await startPlugin(plugin, { stored: JSON.stringify({ targetRule: "last-only" }) });
    const reply = await composer(run, { replyingTo: AGENTS.alpha.name });
    reply.form.pressEnter();
    expectTag("last-only", reply.replaced, AGENTS.beta);
    run.live([userMessage(run, { id: "s-last", parent: run.fixture.byId("alpha-1") })]);
    await settle();
    expectWake("last-only", run.wakes, AGENTS.beta, "last agent", run.fixture.root);
  });
  await scenario("settings: each layer can be turned off", async () => {
    const run = await startPlugin(plugin, { stored: JSON.stringify({ sendTag: false, wakeFallback: false }) });
    const plain = await composer(run);
    plain.form.pressEnter();
    run.live([userMessage(run, { id: "s-off" })]);
    await settle();
    expect("off", plain.replaced.length === 0 && run.wakes.length === 0, "nothing expected", { tags: plain.replaced, wakes: run.wakes });
  });
  await scenario("settings: invalid saved values fall back to defaults and are reported", async () => {
    const broken = await startPlugin(plugin, { stored: "{not json" });
    const plain = await composer(broken);
    plain.form.pressEnter();
    expectTag("invalid-json", plain.replaced, AGENTS.beta);
    const card = broken.React.mount(broken.registered.cards[0].component, { active: () => true });
    expect("invalid-json", /not JSON/.test(textOf(card.tree)), "card must report the broken value", textOf(card.tree));
    const partly = await startPlugin(plugin, { stored: JSON.stringify({ targetRule: "bogus", wakeFallback: false }) });
    const reply = await composer(partly, { replyingTo: AGENTS.alpha.name });
    reply.form.pressEnter();
    expectTag("invalid-field", reply.replaced, AGENTS.alpha);
    partly.live([userMessage(partly, { id: "s-partly" })]);
    await settle();
    expect("invalid-field", partly.wakes.length === 0, "valid fields must still apply", partly.wakes);
  });
  await scenario("settings: changes in the card persist and apply at once", async () => {
    const run = await startPlugin(plugin);
    const card = run.React.mount(run.registered.cards[0].component, { active: () => true });
    findByName(card.tree, "targetRule").props.onChange({ target: { value: "reply-only" } });
    findByName(card.tree, "wakeFallback").props.onChange({ target: { checked: false } });
    const saved = JSON.parse(run.storage.raw());
    expect("card", saved.targetRule === "reply-only" && saved.wakeFallback === false, "settings must be saved", saved);
    const plain = await composer(run);
    plain.form.pressEnter();
    expect("card", plain.replaced.length === 0, "new rule must apply without restart", plain.replaced);
    findByName(card.tree, "targetRule").props.onChange({ target: { value: "<script>" } });
    expect("card", JSON.parse(run.storage.raw()).targetRule === "reply-only", "an invalid choice must not be saved");
    expect("card", /not valid/.test(textOf(card.tree)), "card must show why it refused", textOf(card.tree));
    findByName(card.tree, "reset").props.onClick();
    expect("card", run.storage.raw() === undefined, "restore defaults must clear the saved value");
    const inactive = run.React.mount(run.registered.cards[0].component, { active: () => false });
    findByName(inactive.tree, "sendTag").props.onChange({ target: { checked: false } });
    expect("card", run.storage.raw() === undefined, "an inactive card must not save");
  });
}

async function main() {
  const path = resolve(process.argv[2] ?? DEFAULT_PLUGIN);
  const plugin = await import(pathToFileURL(path).href);
  const hasSettings = plugin.inject.includes("settingsCards");
  await sendTagScenarios(plugin);
  await wakeScenarios(plugin);
  if (hasSettings) await settingsScenarios(plugin);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.ok) console.log(`      ${r.error?.stack ?? r.error}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`smoke: ${results.length - failed}/${results.length} passed (${path}${hasSettings ? "" : ", no settings card"})`);
  process.exitCode = failed ? 1 : 0;
}

await main();
