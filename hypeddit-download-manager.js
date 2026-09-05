(() => {
  const DEFAULT_TIMEOUT_MS = 30000;

  function isHypedditUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && /^(?:www\.)?hypeddit\.com$/i.test(url.hostname)
        && /^\/[^/]+(?:\/[^/]+)?\/?$/.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function comparableUrl(value) {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function hostnameOf(value) {
    try { return new URL(value).hostname.toLowerCase(); } catch (_) { return ""; }
  }

  function filenameOf(download) {
    const value = typeof download?.filename === "string" ? download.filename : "";
    return value.split(/[\\/]/).pop() || "";
  }

  function create(browser, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const queue = [];
    const runsByRunId = new Map();
    const runsByTabId = new Map();
    const runsByDownloadId = new Map();
    let activeRun = null;

    async function sendProgress(run, state, message = "") {
      try {
        await browser.runtime.sendMessage({ type: "hypedditDownloadProgress", runId: run.runId, state, message });
      } catch (_) {
        // The sidebar may be closed while a background-owned run continues.
      }
    }

    function rememberPage(run, value) {
      const url = comparableUrl(value);
      if (url) run.pageUrls.add(url);
    }

    async function ownTab(run, tab) {
      if (!Number.isInteger(tab?.id)) return;
      run.tabIds.add(tab.id);
      runsByTabId.set(tab.id, run);
      rememberPage(run, tab.url);
      try { await browser.tabs.update(tab.id, { muted: true }); } catch (_) { /* the tab may already have closed */ }
    }

    async function closeOwnedTabs(run) {
      run.closing = true;
      const ids = [...run.tabIds];
      ids.forEach((tabId) => runsByTabId.delete(tabId));
      run.tabIds.clear();
      await Promise.all(ids.map((tabId) => browser.tabs.remove(tabId).catch(() => {})));
    }

    function clearTimer(run) {
      if (!run.timeout) return;
      clearTimeout(run.timeout);
      run.timeout = null;
    }

    function releaseActive(run) {
      if (activeRun === run) activeRun = null;
    }

    async function fail(run, error) {
      if (!run || run.finished) return;
      run.finished = true;
      clearTimer(run);
      releaseActive(run);
      const queuedIndex = queue.indexOf(run);
      if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
      runsByRunId.delete(run.runId);
      await closeOwnedTabs(run);
      await sendProgress(run, "failed", error instanceof Error ? error.message : String(error));
      void pump();
    }

    function downloadMatches(run, download) {
      if (!run || run.phase !== "waiting-for-download") return false;
      const referrer = comparableUrl(download?.referrer);
      if (referrer && /^(?:www\.)?hypeddit\.com$/i.test(hostnameOf(referrer))) return true;
      if (referrer && run.pageUrls.has(referrer)) return true;
      const url = comparableUrl(download?.finalUrl || download?.url);
      return Boolean(url && run.pageUrls.has(url));
    }

    async function finishDownload(run, state, message) {
      if (!run || run.finished) return;
      run.finished = true;
      runsByDownloadId.delete(run.downloadId);
      runsByRunId.delete(run.runId);
      await sendProgress(run, state, message);
    }

    async function invokeRunner(run) {
      if (run.finished || run.executing) return;
      run.executing = true;
      try {
        const tab = await browser.tabs.get(run.rootTabId);
        rememberPage(run, tab.url);
        // Firefox can report a transient about:blank (or another intermediate
        // document) as complete while the requested Hypeddit page is still
        // navigating. Keep the run in its opening phase and wait for the next
        // supported completion event instead of treating that as a redirect.
        if (!isHypedditUrl(tab.url)) return;
        clearTimer(run);
        run.phase = "waiting-for-download";
        run.timeout = setTimeout(() => {
          void fail(run, new Error("Firefox did not create the Hypeddit download in time."));
        }, timeoutMs);
        await sendProgress(run, "processing", "Activating Hypeddit's final Download control…");
        await browser.scripting.executeScript({ target: { tabId: run.rootTabId }, files: ["hypeddit-download-runner.js"] });
        const results = await browser.scripting.executeScript({
          target: { tabId: run.rootTabId },
          func: () => globalThis.HypedditDownloadRunner.run()
        });
        if (run.phase === "downloading" || run.finished) return;
        const mainFrameResult = results.find((entry) => entry.frameId === 0) || results[0];
        if (mainFrameResult?.error) throw new Error(mainFrameResult.error?.message || String(mainFrameResult.error));
        if (mainFrameResult?.result?.phase !== "clicked") {
          throw new Error("Hypeddit automation returned an invalid response.");
        }
      } catch (error) {
        await fail(run, error);
      } finally {
        run.executing = false;
      }
    }

    async function pump() {
      if (activeRun || queue.length === 0) return;
      const run = queue.shift();
      activeRun = run;
      run.phase = "opening";
      await sendProgress(run, "opening", "Opening Hypeddit in a muted background tab…");
      try {
        const tab = await browser.tabs.create({ url: run.url, active: false });
        run.rootTabId = tab.id;
        await ownTab(run, tab);
        run.timeout = setTimeout(() => {
          void fail(run, new Error("Hypeddit did not finish opening a supported download page in time."));
        }, timeoutMs);
        if (tab.status === "complete" && isHypedditUrl(tab.url)) void invokeRunner(run);
      } catch (error) {
        await fail(run, error);
      }
    }

    async function start(message) {
      const runId = typeof message?.runId === "string" ? message.runId : "";
      if (!runId) throw new Error("The Hypeddit download request is missing its report item.");
      if (!isHypedditUrl(message?.url)) throw new Error("The requested Hypeddit URL is not supported.");
      if (runsByRunId.has(runId)) return { started: false, duplicate: true };
      const run = {
        runId,
        url: message.url,
        phase: "queued",
        rootTabId: null,
        tabIds: new Set(),
        pageUrls: new Set([comparableUrl(message.url)]),
        executing: false,
        finished: false,
        closing: false,
        timeout: null,
        downloadId: null,
        filename: ""
      };
      runsByRunId.set(runId, run);
      queue.push(run);
      await sendProgress(run, "queued", "Queued for Hypeddit download.");
      void pump();
      return { started: true, queued: activeRun !== run };
    }

    async function onTabCreated(tab) {
      const run = runsByTabId.get(tab?.openerTabId);
      if (!run || run.finished) return;
      await ownTab(run, tab);
    }

    function onTabUpdated(tabId, changeInfo, tab) {
      const run = runsByTabId.get(tabId);
      if (!run || run.finished) return;
      const currentUrl = changeInfo?.url || tab?.url || "";
      rememberPage(run, currentUrl);
      if (tabId === run.rootTabId && run.phase === "opening" && changeInfo?.status === "complete" && isHypedditUrl(currentUrl)) {
        void invokeRunner(run);
      }
    }

    function onTabRemoved(tabId) {
      const run = runsByTabId.get(tabId);
      if (!run) return;
      runsByTabId.delete(tabId);
      run.tabIds.delete(tabId);
      if (!run.closing && tabId === run.rootTabId && run.phase !== "downloading") {
        void fail(run, new Error("The Hypeddit tab was closed before the download started."));
      }
    }

    async function onDownloadCreated(download) {
      const run = activeRun;
      if (!downloadMatches(run, download)) return false;
      clearTimer(run);
      run.phase = "downloading";
      run.downloadId = download.id;
      run.filename = filenameOf(download);
      runsByDownloadId.set(download.id, run);
      releaseActive(run);
      await closeOwnedTabs(run);
      await sendProgress(run, "downloading", run.filename || "Firefox is downloading the file…");
      if (download.state === "complete") await finishDownload(run, "finished", run.filename || "Download complete.");
      else if (download.error) await finishDownload(run, "failed", download.error);
      void pump();
      return true;
    }

    async function onDownloadChanged(delta) {
      const run = runsByDownloadId.get(delta?.id);
      if (!run || run.finished) return false;
      if (delta.filename?.current) run.filename = filenameOf({ filename: delta.filename.current });
      if (delta.state?.current === "complete") {
        await finishDownload(run, "finished", run.filename || "Download complete.");
        return true;
      }
      if (delta.state?.current === "interrupted" || delta.error?.current) {
        await finishDownload(run, "failed", delta.error?.current || "The Hypeddit download was interrupted.");
        return true;
      }
      return false;
    }

    return Object.freeze({
      start,
      onTabCreated,
      onTabUpdated,
      onTabRemoved,
      onDownloadCreated,
      onDownloadChanged,
      isHypedditUrl
    });
  }

  globalThis.HypedditDownloadManager = Object.freeze({ create, isHypedditUrl });
})();
