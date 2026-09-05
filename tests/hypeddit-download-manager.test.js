const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "hypeddit-download-manager.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const messages = [];
  const tabs = new Map();
  const created = [];
  const muted = [];
  const removed = [];
  let nextTabId = 1;

  const browser = {
    runtime: {
      async sendMessage(message) { messages.push(message); }
    },
    tabs: {
      async create({ url, active }) {
        const tab = { id: nextTabId++, url, active, status: "loading" };
        tabs.set(tab.id, tab);
        created.push({ ...tab });
        return { ...tab };
      },
      async update(tabId, changes) {
        if (!tabs.has(tabId)) throw new Error("Missing tab");
        muted.push({ tabId, ...changes });
      },
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error("Missing tab");
        return { ...tabs.get(tabId) };
      },
      async remove(tabId) {
        removed.push(tabId);
        tabs.delete(tabId);
      }
    },
    scripting: {
      async executeScript(options) {
        if (options.files) return [{ frameId: 0, result: undefined }];
        return [{ frameId: 0, result: { phase: "clicked" } }];
      }
    }
  };
  const context = { browser, URL, clearTimeout, setTimeout };
  vm.runInNewContext(source, context);
  const manager = context.HypedditDownloadManager.create(browser, { timeoutMs: 5000 });
  return { browser, manager, messages, tabs, created, muted, removed };
}

async function completeRootLoad(mock, index = 0) {
  const tab = mock.created[index];
  mock.tabs.get(tab.id).status = "complete";
  mock.manager.onTabUpdated(tab.id, { status: "complete" }, { ...mock.tabs.get(tab.id) });
  await flush();
}

test("validates supported Hypeddit URLs", () => {
  const { manager } = harness();
  assert.equal(manager.isHypedditUrl("https://hypeddit.com/artist/release"), true);
  assert.equal(manager.isHypedditUrl("https://www.hypeddit.com/track/abc"), true);
  assert.equal(manager.isHypedditUrl("http://hypeddit.com/artist/release"), false);
  assert.equal(manager.isHypedditUrl("https://hypeddit.com/a/b/c"), false);
  assert.equal(manager.isHypedditUrl("https://example.com/a/b"), false);
});

test("queues jobs FIFO and starts the next job when a download is created", async () => {
  const mock = harness();
  await mock.manager.start({ runId: "first", url: "https://hypeddit.com/a/one" });
  await mock.manager.start({ runId: "second", url: "https://hypeddit.com/b/two" });
  await flush();
  assert.equal(mock.created.length, 1);
  assert.deepEqual(mock.created.map((tab) => tab.url), ["https://hypeddit.com/a/one"]);

  await completeRootLoad(mock);
  const matched = await mock.manager.onDownloadCreated({
    id: 41,
    url: "https://cdn.example.test/first.mp3",
    referrer: "https://hypeddit.com/a/one",
    filename: "C:\\Downloads\\first.mp3",
    state: "in_progress"
  });
  await flush();
  assert.equal(matched, true);
  assert.equal(mock.created.length, 2);
  assert.deepEqual(mock.created.map((tab) => tab.url), [
    "https://hypeddit.com/a/one",
    "https://hypeddit.com/b/two"
  ]);
  assert.ok(mock.messages.some((message) => message.runId === "first" && message.state === "downloading"));
});

test("ignores a transient about:blank completion before Hypeddit finishes loading", async () => {
  const mock = harness();
  await mock.manager.start({ runId: "transition", url: "https://hypeddit.com/a/transition" });
  await flush();
  const root = mock.created[0];

  mock.tabs.get(root.id).url = "about:blank";
  mock.tabs.get(root.id).status = "complete";
  mock.manager.onTabUpdated(root.id, { status: "complete", url: "about:blank" }, { ...mock.tabs.get(root.id) });
  await flush();
  assert.equal(mock.messages.some((message) => message.runId === "transition" && message.state === "failed"), false);
  assert.equal(mock.messages.some((message) => message.runId === "transition" && message.state === "processing"), false);

  mock.tabs.get(root.id).url = "https://hypeddit.com/a/transition";
  mock.manager.onTabUpdated(root.id, { status: "complete", url: "https://hypeddit.com/a/transition" }, { ...mock.tabs.get(root.id) });
  await flush();
  assert.ok(mock.messages.some((message) => message.runId === "transition" && message.state === "processing"));
});

test("mutes and closes the root tab and its child tabs", async () => {
  const mock = harness();
  await mock.manager.start({ runId: "owned", url: "https://hypeddit.com/a/owned" });
  await flush();
  const root = mock.created[0];
  const child = { id: 99, openerTabId: root.id, url: "https://landing.example/file", status: "complete" };
  mock.tabs.set(child.id, child);
  await mock.manager.onTabCreated(child);
  await completeRootLoad(mock);
  await mock.manager.onDownloadCreated({
    id: 42,
    url: "https://files.example/owned.wav",
    referrer: child.url,
    filename: "owned.wav",
    state: "in_progress"
  });
  assert.deepEqual(mock.muted.map((entry) => entry.tabId).sort((a, b) => a - b), [root.id, child.id]);
  assert.deepEqual(mock.removed.sort((a, b) => a - b), [root.id, child.id]);
});

test("ignores unrelated downloads", async () => {
  const mock = harness();
  await mock.manager.start({ runId: "safe", url: "https://hypeddit.com/a/safe" });
  await flush();
  await completeRootLoad(mock);
  const matched = await mock.manager.onDownloadCreated({
    id: 43,
    url: "https://unrelated.example/file.zip",
    referrer: "https://unrelated.example/page",
    filename: "file.zip",
    state: "in_progress"
  });
  assert.equal(matched, false);
  assert.equal(mock.removed.length, 0);
});

test("fails a manually closed root tab and advances the queue", async () => {
  const mock = harness();
  await mock.manager.start({ runId: "closed", url: "https://hypeddit.com/a/closed" });
  await mock.manager.start({ runId: "next", url: "https://hypeddit.com/a/next" });
  await flush();
  const root = mock.created[0];
  mock.tabs.delete(root.id);
  mock.manager.onTabRemoved(root.id);
  await flush();
  assert.ok(mock.messages.some((message) => message.runId === "closed" && message.state === "failed"));
  assert.equal(mock.created.length, 2);
  assert.equal(mock.created[1].url, "https://hypeddit.com/a/next");
});

test("reports completion and interruption by retained download ID", async () => {
  const mock = harness();
  await mock.manager.start({ runId: "complete", url: "https://hypeddit.com/a/complete" });
  await flush();
  await completeRootLoad(mock);
  await mock.manager.onDownloadCreated({ id: 44, url: "https://cdn.test/a.mp3", referrer: "https://hypeddit.com/a/complete", filename: "a.mp3", state: "in_progress" });
  assert.equal(await mock.manager.onDownloadChanged({ id: 44, state: { current: "complete" } }), true);
  assert.ok(mock.messages.some((message) => message.runId === "complete" && message.state === "finished"));

  await mock.manager.start({ runId: "interrupted", url: "https://hypeddit.com/a/interrupted" });
  await flush();
  await completeRootLoad(mock, 1);
  await mock.manager.onDownloadCreated({ id: 45, url: "https://cdn.test/b.mp3", referrer: "https://hypeddit.com/a/interrupted", filename: "b.mp3", state: "in_progress" });
  assert.equal(await mock.manager.onDownloadChanged({ id: 45, state: { current: "interrupted" }, error: { current: "NETWORK_FAILED" } }), true);
  assert.ok(mock.messages.some((message) => message.runId === "interrupted" && message.state === "failed" && message.message === "NETWORK_FAILED"));
});

test("rejects duplicate active or queued run IDs", async () => {
  const mock = harness();
  const first = await mock.manager.start({ runId: "duplicate", url: "https://hypeddit.com/a/duplicate" });
  const second = await mock.manager.start({ runId: "duplicate", url: "https://hypeddit.com/a/duplicate" });
  assert.equal(first.started, true);
  assert.deepEqual({ ...second }, { started: false, duplicate: true });
});
