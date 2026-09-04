const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "account-probe.js"), "utf8");

async function runProbe(resolveSelector) {
  let now = 0;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const context = {
    Date: FakeDate,
    location: { hostname: "accounts.spotify.com" },
    document: { querySelector: resolveSelector },
    setTimeout(callback, delay) {
      now += delay;
      queueMicrotask(callback);
    }
  };
  return vm.runInNewContext(source, context);
}

test("reports a signed-out Spotify status", async () => {
  const result = await runProbe((selector) => selector.includes("status-logged-out") ? {} : null);
  assert.deepEqual({ ...result }, { state: "signed-out" });
});

test("reads the Spotify username from user-info", async () => {
  const username = { textContent: "  Example User  " };
  const userInfo = { textContent: "Logged in as", parentElement: { children: [null, { textContent: "" }, username] } };
  const loggedIn = { querySelector: (selector) => selector.includes("user-info") ? userInfo : null };
  const result = await runProbe((selector) => selector.includes("status-logged-in") ? loggedIn : null);
  assert.deepEqual({ ...result }, { state: "signed-in", username: "Example User" });
});

test("reads the Spotify username from its bootstrap payload", async () => {
  const bootstrap = {
    getAttribute: () => JSON.stringify({ user: { displayName: "sseiw" }, flowCtx: "test" })
  };
  const result = await runProbe((selector) => selector.includes("bootstrap-data") ? bootstrap : null);
  assert.deepEqual({ ...result }, { state: "signed-in", username: "sseiw" });
});

test("waits for Spotify's client-rendered status", async () => {
  let attempts = 0;
  const result = await runProbe((selector) => {
    if (selector.includes("status-logged-out")) {
      attempts += 1;
      return attempts >= 4 ? {} : null;
    }
    return null;
  });
  assert.equal(result.state, "signed-out");
  assert.equal(attempts, 4);
});

test("returns an error when Spotify never renders a status marker", async () => {
  const result = await runProbe(() => null);
  assert.equal(result.state, "error");
  assert.match(result.message, /did not load in time/i);
});

test("rejects execution on a non-Spotify host", async () => {
  const context = {
    location: { hostname: "example.com" },
    document: { querySelector: () => null },
    setTimeout
  };
  await assert.rejects(vm.runInNewContext(source, context), /unexpected website/i);
});
