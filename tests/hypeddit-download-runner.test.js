const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "hypeddit-download-runner.js"), "utf8");

function loadRunner({ href = "https://hypeddit.com/artist/track", button = null, immediateTimeout = false } = {}) {
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  const context = {
    URL,
    location: { href },
    document: {
      documentElement: {},
      querySelector: () => button
    },
    MutationObserver: FakeMutationObserver,
    clearTimeout,
    setTimeout: immediateTimeout ? (callback) => { queueMicrotask(callback); return 1; } : setTimeout
  };
  vm.runInNewContext(source, context);
  return context.HypedditDownloadRunner;
}

test("accepts canonical Hypeddit gate URLs and rejects unsafe alternatives", () => {
  const runner = loadRunner();
  for (const url of [
    "https://hypeddit.com/track/abc123",
    "https://www.hypeddit.com/artist/release",
    "https://hypeddit.com/abc123"
  ]) assert.equal(runner.isSupportedPage(url), true, url);

  for (const url of [
    "http://hypeddit.com/artist/release",
    "https://example.com/artist/release",
    "https://hypeddit.com/one/two/three",
    "not a url"
  ]) assert.equal(runner.isSupportedPage(url), false, url);
});

test("clicks the original hidden final button without replacing it", async () => {
  let clicks = 0;
  const button = {
    tagName: "A",
    id: "gateDownloadButton",
    click() { clicks += 1; }
  };
  const runner = loadRunner({ button });
  const result = await runner.run();
  assert.equal(clicks, 1);
  assert.deepEqual({ ...result }, { phase: "clicked" });
});

test("fails when the final button never appears", async () => {
  const runner = loadRunner({ immediateTimeout: true });
  await assert.rejects(runner.run(), /timed out waiting/i);
});

test("does not run on an unsupported page", async () => {
  const runner = loadRunner({ href: "https://example.com/artist/track" });
  await assert.rejects(runner.run(), /unsupported page/i);
});
