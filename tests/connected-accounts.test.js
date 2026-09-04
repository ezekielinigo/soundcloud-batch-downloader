const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "connected-accounts.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => [...listeners].forEach((listener) => listener(...args))
  };
}

function harness({
  spotifyResult = { state: "signed-in", username: "Spotify User" },
  failSpotify = false,
  soundcloudFinalUrl = "https://soundcloud.com/test_user"
} = {}) {
  const onUpdated = event();
  const onRemoved = event();
  const tabs = new Map();
  const removed = [];
  const openedWindows = [];
  let nextTabId = 1;
  let createCount = 0;

  const browser = {
    tabs: {
      onUpdated,
      onRemoved,
      async create({ url }) {
        createCount += 1;
        const tab = { id: nextTabId++, status: "loading", url };
        tabs.set(tab.id, tab);
        queueMicrotask(() => {
          tab.status = "complete";
          tab.url = "about:blank";
          onUpdated.emit(tab.id, { status: "complete", url: tab.url }, { ...tab });
          tab.status = "loading";
          onUpdated.emit(tab.id, { status: "loading" }, { ...tab });
          tab.status = "complete";
          if (url.includes("soundcloud.com/you")) tab.url = soundcloudFinalUrl;
          else tab.url = "https://accounts.spotify.com/en/status?flow_ctx=test";
          onUpdated.emit(tab.id, { status: "complete", url: tab.url }, { ...tab });
        });
        return { ...tab };
      },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("Missing tab");
        return { ...tab };
      },
      async remove(tabId) {
        removed.push(tabId);
        tabs.delete(tabId);
        onRemoved.emit(tabId);
      }
    },
    scripting: {
      async executeScript() {
        if (failSpotify) throw new Error("Injection failed");
        return [{ frameId: 0, result: spotifyResult }];
      }
    },
    windows: {
      async create(options) { openedWindows.push(options); }
    }
  };
  const context = { browser, clearTimeout, setTimeout, URL };
  vm.runInNewContext(source, context);
  return {
    accounts: context.ConnectedAccounts,
    createCount: () => createCount,
    openedWindows,
    removed
  };
}

test("checks both providers once and deduplicates concurrent refreshes", async () => {
  const mock = harness();
  const first = mock.accounts.checkAll();
  const second = mock.accounts.checkAll();
  assert.strictEqual(first, second);
  const results = await first;
  assert.equal(mock.createCount(), 2);
  assert.deepEqual(plain(results.map((result) => result.state)), ["signed-in", "signed-in"]);
  assert.deepEqual(mock.removed.sort(), [1, 2]);
});

test("derives the SoundCloud username from the final redirected URL", async () => {
  const mock = harness({ spotifyResult: { state: "signed-out" } });
  const results = await mock.accounts.checkAll();
  const soundcloud = results.find((result) => result.service === "soundcloud");
  assert.equal(soundcloud.state, "signed-in");
  assert.equal(soundcloud.username, "test_user");
});

test("reports SoundCloud as signed out when /you redirects to sign-in", async () => {
  const mock = harness({ soundcloudFinalUrl: "https://soundcloud.com/signin?redirect=%2Fyou" });
  const results = await mock.accounts.checkAll();
  const soundcloud = results.find((result) => result.service === "soundcloud");
  assert.equal(soundcloud.state, "signed-out");
});

test("opens from cached state without running another probe", async () => {
  const mock = harness({ spotifyResult: { state: "signed-out" } });
  await mock.accounts.checkAll();
  const probesBeforeOpening = mock.createCount();
  await mock.accounts.open("soundcloud");
  await mock.accounts.open("spotify");
  assert.equal(mock.createCount(), probesBeforeOpening);
  assert.deepEqual(plain(mock.openedWindows), [
    { url: "https://soundcloud.com/" },
    { url: "https://accounts.spotify.com/login" }
  ]);
});

test("closes probe tabs and preserves an individual provider error", async () => {
  const mock = harness({ failSpotify: true });
  const results = await mock.accounts.checkAll();
  const spotify = results.find((result) => result.service === "spotify");
  assert.equal(spotify.state, "error");
  assert.match(spotify.message, /injection failed/i);
  assert.deepEqual(mock.removed.sort(), [1, 2]);
});

test("opens the probe page when no cached state exists", async () => {
  const mock = harness();
  await mock.accounts.open("spotify");
  assert.equal(mock.createCount(), 0);
  assert.deepEqual(plain(mock.openedWindows), [{ url: "https://accounts.spotify.com/status" }]);
});
