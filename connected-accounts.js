globalThis.ConnectedAccounts = (() => {
  "use strict";

  const PROBE_TIMEOUT_MS = 15000;
  const SERVICES = Object.freeze({
    soundcloud: Object.freeze({
      label: "SoundCloud",
      probeUrl: "https://soundcloud.com/you",
      signedOutUrl: "https://soundcloud.com/signin",
      homeUrl: "https://soundcloud.com/"
    }),
    spotify: Object.freeze({
      label: "Spotify",
      probeUrl: "https://accounts.spotify.com/status",
      signedOutUrl: "https://accounts.spotify.com/login",
      homeUrl: "https://open.spotify.com/"
    })
  });
  const latestStates = new Map();
  let activeCheck = null;

  function resultFor(service, state, detail = {}) {
    return { service, label: SERVICES[service].label, state, ...detail };
  }

  function soundCloudResultFromUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "soundcloud.com") {
      throw new Error("SoundCloud redirected to an unexpected website.");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && !new Set(["you", "signin", "signup", "discover", "stream", "search"]).has(parts[0].toLowerCase())) {
      return resultFor("soundcloud", "signed-in", { username: decodeURIComponent(parts[0]) });
    }
    return resultFor("soundcloud", "signed-out");
  }

  function waitForTabComplete(tabId, acceptsUrl, timeout = PROBE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, tab) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        browser.tabs.onUpdated.removeListener(onUpdated);
        browser.tabs.onRemoved.removeListener(onRemoved);
        if (error) reject(error); else resolve(tab);
      };
      const acceptCompletedTab = (tab) => {
        if (tab.status === "complete" && acceptsUrl(tab.url)) finish(null, tab);
      };
      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
        browser.tabs.get(tabId).then(acceptCompletedTab).catch((error) => finish(error));
      };
      const onRemoved = (removedTabId) => {
        if (removedTabId === tabId) finish(new Error("The account-check tab was closed before it finished."));
      };
      const timeoutId = setTimeout(() => finish(new Error("The account page took too long to load.")), timeout);
      browser.tabs.onUpdated.addListener(onUpdated);
      browser.tabs.onRemoved.addListener(onRemoved);
      browser.tabs.get(tabId).then(acceptCompletedTab).catch((error) => finish(error));
    });
  }

  function isExpectedProbeUrl(service, value) {
    try {
      const url = new URL(value);
      if (service === "soundcloud") return url.protocol === "https:" && url.hostname === "soundcloud.com";
      return url.protocol === "https:"
        && url.hostname === "accounts.spotify.com"
        && /(?:^|\/)status\/?$/i.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  async function probeService(service) {
    const config = SERVICES[service];
    if (!config) throw new Error("Unknown account service.");
    let tab;
    try {
      tab = await browser.tabs.create({ url: config.probeUrl, active: false });
      const finalTab = await waitForTabComplete(tab.id, (url) => isExpectedProbeUrl(service, url));
      if (service === "soundcloud") return soundCloudResultFromUrl(finalTab.url);

      const executions = await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["account-probe.js"] });
      const probe = executions.find((entry) => entry.frameId === 0)?.result;
      if (probe?.state === "signed-in" && typeof probe.username === "string" && probe.username.trim()) {
        return resultFor(service, "signed-in", { username: probe.username.trim() });
      }
      if (probe?.state === "signed-out") return resultFor(service, "signed-out");
      throw new Error(probe?.message || "The account page returned an unknown status.");
    } catch (error) {
      return resultFor(service, "error", { message: error.message || "The account page could not be checked." });
    } finally {
      if (tab?.id != null) await browser.tabs.remove(tab.id).catch(() => {});
    }
  }

  function checkAll() {
    if (activeCheck) return activeCheck;
    activeCheck = Promise.all(Object.keys(SERVICES).map(probeService))
      .then((results) => {
        results.forEach((result) => latestStates.set(result.service, result));
        return results;
      })
      .finally(() => { activeCheck = null; });
    return activeCheck;
  }

  async function open(service) {
    const config = SERVICES[service];
    if (!config) throw new Error("Unknown account service.");
    const state = latestStates.get(service)?.state;
    const url = state === "signed-in"
      ? config.homeUrl
      : state === "signed-out"
        ? config.signedOutUrl
        : config.probeUrl;
    await browser.windows.create({ url });
  }

  return Object.freeze({ checkAll, open });
})();
