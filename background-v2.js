// The long-running report stays in the sidebar. This background page only
// opens it and supplies the same internal track batches that SoundCloud's web
// app requests. No SoundCloud developer API account or application key is
// required: the request template is observed from the signed-in page itself.

const TRACKS_ENDPOINT = "https://api-v2.soundcloud.com/tracks";
const TRACK_BATCH_SIZE = 30;
const REQUEST_CONTEXT_PREFIX = "soundcloudRequestContext:";
const memoryRequestContexts = new Map();
const BANDCAMP_RUN_TIMEOUT_MS = 30000;
const DOWNLOAD_START_TIMEOUT_MS = 30000;
const SETTINGS_KEY = "settings";
const BANDCAMP_FILE_TYPES = new Set(["mp3-v0", "mp3-320", "flac", "aac", "ogg-vorbis", "alac", "wav", "aiff"]);
const bandcampRunsByTabId = new Map();
const activeBandcampRunIds = new Map();
const soundcloudRunsByTabId = new Map();
const activeSoundcloudRunIds = new Map();

browser.action.onClicked.addListener(() => browser.sidebarAction.open());

function contextStorageKey(tabId) {
  return `${REQUEST_CONTEXT_PREFIX}${tabId}`;
}

function allowedTemplate(value) {
  try {
    const source = new URL(value);
    if (source.protocol !== "https:" || source.hostname !== "api-v2.soundcloud.com") return null;

    const target = new URL(TRACKS_ENDPOINT);
    for (const name of ["client_id", "app_version", "app_locale"]) {
      const parameter = source.searchParams.get(name);
      if (parameter) target.searchParams.set(name, parameter);
    }
    return target.searchParams.has("client_id") ? target.href : null;
  } catch (_) {
    return null;
  }
}

async function rememberRequestContext(tabId, context) {
  if (!Number.isInteger(tabId) || tabId < 0 || !context.templateUrl) return;
  const stored = { ...context, capturedAt: Date.now() };
  memoryRequestContexts.set(tabId, stored);
  try {
    await browser.storage.session.set({ [contextStorageKey(tabId)]: stored });
  } catch (_) {
    // Firefox versions without storage.session still retain the in-memory copy
    // for as long as this background page is alive.
  }
}

async function requestContextForTab(tabId) {
  if (memoryRequestContexts.has(tabId)) return memoryRequestContexts.get(tabId);
  try {
    const key = contextStorageKey(tabId);
    const stored = (await browser.storage.session.get(key))[key];
    if (stored) {
      memoryRequestContexts.set(tabId, stored);
      return stored;
    }
  } catch (_) { /* use the page-supplied public template */ }
  return null;
}

async function forgetRequestContext(tabId) {
  memoryRequestContexts.delete(tabId);
  try { await browser.storage.session.remove(contextStorageKey(tabId)); } catch (_) { /* unavailable */ }
}

browser.tabs.onRemoved.addListener((tabId) => { void forgetRequestContext(tabId); });
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  try {
    const url = new URL(changeInfo.url);
    if (!(url.hostname === "soundcloud.com" || url.hostname.endsWith(".soundcloud.com"))) {
      void forgetRequestContext(tabId);
    }
  } catch (_) {
    void forgetRequestContext(tabId);
  }
});

function isBandcampReleaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && /^[^.]+\.bandcamp\.com$/i.test(url.hostname)
      && /^\/(track|album)\/[^/]+\/?$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function isBandcampPageUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "bandcamp.com" || url.hostname.endsWith(".bandcamp.com");
  } catch (_) {
    return false;
  }
}

function normalizedBandcampSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const timeout = Number.isInteger(source.tabTimeout) && source.tabTimeout >= 0 ? source.tabTimeout : 30000;
  return {
    bandcampEmail: typeof source.bandcampEmail === "string" ? source.bandcampEmail.trim() : "",
    bandcampFileType: BANDCAMP_FILE_TYPES.has(source.bandcampFileType) ? source.bandcampFileType : "mp3-v0",
    autoCloseTabs: source.autoCloseTabs === true,
    tabTimeout: timeout
  };
}

async function sendBandcampProgress(run, state, message = "") {
  try {
    await browser.runtime.sendMessage({ type: "bandcampDownloadProgress", runId: run.runId, state, message });
  } catch (_) {
    // The sidebar may have been closed while the background-owned tab continues.
  }
}

function clearBandcampRun(run) {
  if (run.navigationTimeout) clearTimeout(run.navigationTimeout);
  if (run.downloadStartTimeout) clearTimeout(run.downloadStartTimeout);
  if (run.closeTimeout) clearTimeout(run.closeTimeout);
  bandcampRunsByTabId.delete(run.tabId);
  activeBandcampRunIds.delete(run.runId);
}

function downloadedFilename(download) {
  const filename = typeof download?.filename === "string" ? download.filename : "";
  return filename.split(/[\\/]/).pop() || "Download started.";
}

function isSoundcloudTrackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "soundcloud.com" && /^\/[^/]+\/[^/]+/.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function clearSoundcloudRun(run) {
  if (run.downloadStartTimeout) clearTimeout(run.downloadStartTimeout);
  if (run.closeTimeout) clearTimeout(run.closeTimeout);
  soundcloudRunsByTabId.delete(run.tabId);
  activeSoundcloudRunIds.delete(run.runId);
}

function soundcloudDownloadMatchesRun(run, download) {
  if (run.phase !== "waiting-for-download") return false;
  try {
    const source = new URL(download?.finalUrl || download?.url || "");
    const referrer = new URL(download?.referrer || "https://soundcloud.com/");
    return source.protocol === "https:"
      && source.hostname === "cf-media.sndcdn.com"
      && (referrer.hostname === "soundcloud.com" || referrer.hostname.endsWith(".soundcloud.com"));
  } catch (_) {
    return false;
  }
}

async function failSoundcloudRun(run, error) {
  if (!run || run.finished) return;
  run.finished = true;
  clearSoundcloudRun(run);
  try {
    await browser.runtime.sendMessage({ type: "soundcloudDownloadProgress", runId: run.runId, state: "failed", message: error.message || String(error) });
  } catch (_) { /* sidebar closed */ }
}

async function finishSoundcloudDownload(run, download) {
  if (!run || run.finished || !soundcloudDownloadMatchesRun(run, download)) return;
  run.finished = true;
  if (run.downloadStartTimeout) clearTimeout(run.downloadStartTimeout);
  activeSoundcloudRunIds.delete(run.runId);
  try {
    await browser.runtime.sendMessage({ type: "soundcloudDownloadProgress", runId: run.runId, state: "started", message: downloadedFilename(download) });
  } catch (_) { /* sidebar closed */ }
  if (run.settings.autoCloseTabs) {
    run.closeTimeout = setTimeout(() => {
      run.closing = true;
      void browser.tabs.remove(run.tabId).catch(() => {}).finally(() => clearSoundcloudRun(run));
    }, run.settings.tabTimeout);
  } else {
    soundcloudRunsByTabId.delete(run.tabId);
  }
}

async function invokeSoundcloudRunner(run) {
  if (run.finished || run.executing) return;
  run.executing = true;
  try {
    const tab = await browser.tabs.get(run.tabId);
    if (!isSoundcloudTrackUrl(tab.url)) throw new Error("The SoundCloud tab did not open a supported track page.");
    run.trackPageUrl = tab.url;
    run.phase = "waiting-for-download";
    run.automationStartedAt = Date.now();
    run.downloadStartTimeout = setTimeout(() => {
      void failSoundcloudRun(run, new Error("Firefox did not create the SoundCloud download in time."));
    }, DOWNLOAD_START_TIMEOUT_MS);
    await browser.scripting.executeScript({ target: { tabId: run.tabId, allFrames: true }, files: ["soundcloud-download-runner.js"] });
  } catch (error) {
    await failSoundcloudRun(run, error);
  } finally {
    run.executing = false;
  }
}

async function startSoundcloudDownload(message) {
  const runId = typeof message?.runId === "string" && message.runId.length > 0 ? message.runId : "";
  if (!runId) throw new Error("The SoundCloud download request is missing its report item.");
  if (!isSoundcloudTrackUrl(message?.trackUrl)) throw new Error("The requested SoundCloud page is not a supported track URL.");
  if (activeSoundcloudRunIds.has(runId)) return { started: false, duplicate: true };

  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const tab = await browser.tabs.create({ url: message.trackUrl, active: false });
  const run = { runId, tabId: tab.id, settings: normalizedBandcampSettings(stored[SETTINGS_KEY]), phase: "opening", executing: false, finished: false, closing: false, trackPageUrl: "" };
  soundcloudRunsByTabId.set(tab.id, run);
  activeSoundcloudRunIds.set(runId, run);
  try {
    await browser.runtime.sendMessage({ type: "soundcloudDownloadProgress", runId, state: "opening", message: "Opening SoundCloud in a background tab…" });
  } catch (_) { /* sidebar closed */ }
  if (tab.status === "complete" && isSoundcloudTrackUrl(tab.url)) void invokeSoundcloudRunner(run);
  return { started: true };
}

function runMatchesDownload(run, download) {
  if (run.phase !== "waiting-for-download") return false;
  return download?.url === run.downloadUrl
    || download?.finalUrl === run.downloadUrl
    || (run.downloadPageUrl && download?.referrer === run.downloadPageUrl);
}

function scheduleBandcampTabClose(run) {
  if (!run.settings.autoCloseTabs || run.closeTimeout) return;
  run.closeTimeout = setTimeout(() => {
    run.closing = true;
    void browser.tabs.remove(run.tabId).catch(() => {}).finally(() => clearBandcampRun(run));
  }, run.settings.tabTimeout);
}

async function finishBandcampEmailHandoff(run) {
  run.finished = true;
  activeBandcampRunIds.delete(run.runId);
  await sendBandcampProgress(run, "sent-email", "Bandcamp will send the download link to your saved email address.");
  run.closing = true;
  await browser.tabs.remove(run.tabId).catch(() => {});
  clearBandcampRun(run);
}

async function finishBandcampDownload(run, download) {
  if (!run || run.finished || !runMatchesDownload(run, download)) return;
  run.finished = true;
  if (run.downloadStartTimeout) clearTimeout(run.downloadStartTimeout);
  activeBandcampRunIds.delete(run.runId);
  await sendBandcampProgress(run, "started", downloadedFilename(download));
  if (!run.settings.autoCloseTabs) {
    bandcampRunsByTabId.delete(run.tabId);
  }
}

async function findAlreadyCreatedDownload(run) {
  try {
    const downloads = await browser.downloads.search({ url: run.downloadUrl });
    const download = downloads.find((entry) => runMatchesDownload(run, entry));
    if (download) await finishBandcampDownload(run, download);
  } catch (_) {
    // onCreated remains the primary signal; this only closes a very small race.
  }
}

async function failBandcampRun(run, error) {
  if (!run || run.finished) return;
  run.finished = true;
  clearBandcampRun(run);
  await sendBandcampProgress(run, "failed", error instanceof Error ? error.message : String(error));
}

async function invokeBandcampRunner(run, phase) {
  if (run.finished || run.executing) return;
  run.executing = true;
  try {
    const tab = await browser.tabs.get(run.tabId);
    let currentUrl;
    try {
      currentUrl = new URL(tab.url || "");
    } catch (_) {
      throw new Error("The Bandcamp tab does not have a valid page URL.");
    }
    if (!isBandcampPageUrl(tab.url)) {
      throw new Error(`Bandcamp redirected to ${currentUrl.hostname}, which this automation does not support.`);
    }
    if (phase === "release") {
      run.releasePageUrl = tab.url || run.releasePageUrl;
    }
    await browser.scripting.executeScript({ target: { tabId: run.tabId }, files: ["bandcamp-download-runner.js"] });
    const results = await browser.scripting.executeScript({
      target: { tabId: run.tabId },
      func: (runnerPhase, selectedFileType, email) => globalThis.BandcampDownloadRunner.run(runnerPhase, selectedFileType, email),
      args: [phase, run.settings.bandcampFileType, run.settings.bandcampEmail]
    });
    const mainFrameResult = results.find((entry) => entry.frameId === 0) || results[0];
    if (mainFrameResult?.error) {
      const injectionError = mainFrameResult.error;
      throw new Error(injectionError?.message || String(injectionError));
    }
    const result = mainFrameResult?.result;
    if (!result?.phase) throw new Error("Bandcamp automation returned an invalid response.");

    if (result.phase === "awaiting-download-page") {
      run.phase = "download";
      run.navigationTimeout = setTimeout(() => {
        void failBandcampRun(run, new Error("Timed out waiting for Bandcamp's download page."));
      }, BANDCAMP_RUN_TIMEOUT_MS);
      await sendBandcampProgress(run, "selecting-format", "Opening Bandcamp's download page…");
      const tab = await browser.tabs.get(run.tabId);
      if (tab.status === "complete" && tab.url && tab.url !== run.releasePageUrl) {
        run.downloadPageLoaded = true;
        setTimeout(() => {
          if (!run.finished && run.phase === "download" && run.downloadPageLoaded) {
            void invokeBandcampRunner(run, "download");
          }
        }, 0);
      }
      return;
    }

    if (result.phase === "download-started") {
      if (typeof result.downloadUrl !== "string" || !result.downloadUrl) {
        throw new Error("Bandcamp did not provide a download URL.");
      }
      run.phase = "waiting-for-download";
      run.downloadUrl = result.downloadUrl;
      run.downloadPageUrl = tab.url || "";
      run.downloadStartTimeout = setTimeout(() => {
        void failBandcampRun(run, new Error("Firefox did not create the Bandcamp download in time."));
      }, DOWNLOAD_START_TIMEOUT_MS);
      scheduleBandcampTabClose(run);
      await sendBandcampProgress(run, "processing", "Waiting for Firefox to start the download…");
      void findAlreadyCreatedDownload(run);
      return;
    }

    if (result.phase === "email-sent") {
      await finishBandcampEmailHandoff(run);
      return;
    }

    throw new Error(`Unexpected Bandcamp automation response: ${result.phase}`);
  } catch (error) {
    await failBandcampRun(run, error);
  } finally {
    run.executing = false;
  }
}

async function startBandcampFreeDownload(message) {
  const runId = typeof message?.runId === "string" && message.runId.length > 0 ? message.runId : "";
  if (!runId) throw new Error("The Bandcamp download request is missing its report item.");
  if (!isBandcampReleaseUrl(message?.url)) throw new Error("The requested Bandcamp URL is not a supported release page.");
  if (activeBandcampRunIds.has(runId)) return { started: false, duplicate: true };

  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const settings = normalizedBandcampSettings(stored[SETTINGS_KEY]);
  const tab = await browser.tabs.create({ url: message.url, active: false });
  const run = { runId, tabId: tab.id, settings, phase: "release", executing: false, finished: false, closing: false, releasePageUrl: "", downloadPageLoaded: false };
  bandcampRunsByTabId.set(tab.id, run);
  activeBandcampRunIds.set(runId, run);
  await sendBandcampProgress(run, "opening", "Opening Bandcamp in a background tab…");
  if (tab.status === "complete" && isBandcampPageUrl(tab.url)) void invokeBandcampRunner(run, "release");
  return { started: true };
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const run = bandcampRunsByTabId.get(tabId);
  if (!run || run.finished) return;
  if (run.phase !== "release" && run.phase !== "download") return;
  if (run.phase === "download" && changeInfo.url && changeInfo.url !== run.releasePageUrl) run.downloadPageLoaded = true;
  if (run.executing || changeInfo.status !== "complete") return;
  if (run.phase === "download" && !run.downloadPageLoaded) return;
  if (run.navigationTimeout) {
    clearTimeout(run.navigationTimeout);
    run.navigationTimeout = null;
  }
  void invokeBandcampRunner(run, run.phase);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const run = soundcloudRunsByTabId.get(tabId);
  if (!run || run.finished || run.executing || run.phase !== "opening" || changeInfo.status !== "complete") return;
  void invokeSoundcloudRunner(run);
});

browser.tabs.onRemoved.addListener((tabId) => {
  const run = bandcampRunsByTabId.get(tabId);
  if (!run) return;
  if (run.closing) {
    clearBandcampRun(run);
    return;
  }
  void failBandcampRun(run, new Error("The Bandcamp tab was closed before the download started."));
});

browser.tabs.onRemoved.addListener((tabId) => {
  const run = soundcloudRunsByTabId.get(tabId);
  if (!run) return;
  if (run.closing) {
    clearSoundcloudRun(run);
    return;
  }
  void failSoundcloudRun(run, new Error("The SoundCloud tab was closed before the download started."));
});

browser.downloads.onCreated.addListener((download) => {
  for (const run of bandcampRunsByTabId.values()) {
    if (runMatchesDownload(run, download)) void finishBandcampDownload(run, download);
  }
  const soundcloudRun = [...soundcloudRunsByTabId.values()]
    .filter((run) => soundcloudDownloadMatchesRun(run, download))
    .sort((left, right) => (right.clickedAt || right.automationStartedAt || 0) - (left.clickedAt || left.automationStartedAt || 0))[0];
  if (soundcloudRun) void finishSoundcloudDownload(soundcloudRun, download);
});

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
    const templateUrl = allowedTemplate(details.url);
    if (!templateUrl) return;

    const headers = new Map((details.requestHeaders || []).map((header) => [header.name.toLowerCase(), header.value]));
    void rememberRequestContext(details.tabId, {
      templateUrl,
      authorization: headers.get("authorization") || "",
      dataDomeClientId: headers.get("x-datadome-clientid") || ""
    });
  },
  { urls: [`${TRACKS_ENDPOINT}*`] },
  ["requestHeaders"]
);

function validTrackIds(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 10000) return null;
  const result = values.map(String);
  return result.every((id) => /^\d+$/.test(id)) ? result : null;
}

function publicTrackRecord(track) {
  return {
    id: String(track.id),
    title: typeof track.title === "string" ? track.title : "",
    permalink_url: typeof track.permalink_url === "string" ? track.permalink_url : "",
    description: typeof track.description === "string" ? track.description : "",
    downloadable: track.downloadable === true,
    has_downloads_left: typeof track.has_downloads_left === "boolean" ? track.has_downloads_left : null,
    download_url: typeof track.download_url === "string" ? track.download_url : "",
    purchase_url: typeof track.purchase_url === "string" ? track.purchase_url : "",
    policy: typeof track.policy === "string" ? track.policy : "",
    monetization_model: typeof track.monetization_model === "string" ? track.monetization_model : ""
  };
}

async function fetchTrackBatch(ids, context) {
  const url = new URL(context.templateUrl);
  url.searchParams.set("ids", ids.join(","));
  const headers = { Accept: "application/json" };
  if (context.authorization) headers.Authorization = context.authorization;
  if (context.dataDomeClientId) headers["X-Datadome-Clientid"] = context.dataDomeClientId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url.href, {
      method: "GET",
      headers,
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`SoundCloud metadata request returned ${response.status}.`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("SoundCloud returned an unexpected metadata format.");
    const requested = new Set(ids);
    return payload
      .filter((track) => track && requested.has(String(track.id)))
      .map(publicTrackRecord);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("SoundCloud metadata request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function hydratePlaylistTracks(message) {
  const ids = validTrackIds(message.trackIds);
  if (!ids) throw new Error("The playlist did not provide a valid ordered track-ID list.");
  if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error("The source SoundCloud tab is unavailable.");

  const tab = await browser.tabs.get(message.tabId);
  const tabUrl = new URL(tab.url || "");
  if (!(tabUrl.hostname === "soundcloud.com" || tabUrl.hostname.endsWith(".soundcloud.com"))) {
    throw new Error("The original tab is no longer a SoundCloud page.");
  }

  const captured = await requestContextForTab(message.tabId);
  const fallbackTemplate = allowedTemplate(message.apiTemplate);
  const context = captured?.templateUrl
    ? captured
    : fallbackTemplate
      ? { templateUrl: fallbackTemplate, authorization: "", dataDomeClientId: "" }
      : null;

  if (!context) {
    throw new Error("SoundCloud's metadata request was not observed. Reload the playlist tab once, wait for its first tracks to appear, then scan again.");
  }

  const requestIds = [...new Set(ids)];
  const batches = [];
  for (let index = 0; index < requestIds.length; index += TRACK_BATCH_SIZE) {
    batches.push(requestIds.slice(index, index + TRACK_BATCH_SIZE));
  }

  let records;
  try {
    records = (await Promise.all(batches.map((batch) => fetchTrackBatch(batch, context)))).flat();
  } catch (error) {
    if (!captured?.authorization) {
      throw new Error(`${error.message} Reload the playlist tab once so the extension can observe your signed-in SoundCloud request, then scan again.`);
    }
    throw error;
  }

  const byId = new Map(records.map((track) => [track.id, track]));
  const orderedTracks = ids.map((id) => byId.get(id)).filter(Boolean);
  return {
    tracks: orderedTracks,
    diagnostics: {
      requestedTrackCount: ids.length,
      returnedTrackCount: orderedTracks.length,
      missingTrackCount: ids.length - orderedTracks.length,
      batchCount: batches.length,
      requestContext: captured?.authorization ? "captured signed-in request" : "page request template"
    }
  };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "hydratePlaylistTracks") return hydratePlaylistTracks(message);
  if (message?.type === "startBandcampFreeDownload") return startBandcampFreeDownload(message);
  if (message?.type === "startSoundcloudDownload") return startSoundcloudDownload(message);
  if (message?.type === "soundcloudRunnerResult") {
    const run = soundcloudRunsByTabId.get(sender.tab?.id);
    if (!run || run.finished || run.phase !== "waiting-for-download") return undefined;
    if (!message.ok) {
      void failSoundcloudRun(run, new Error(message.error || "SoundCloud could not click the official download button."));
      return undefined;
    }
    run.clickedAt = Date.now();
    try {
      void browser.runtime.sendMessage({ type: "soundcloudDownloadProgress", runId: run.runId, state: "processing", message: "Waiting for Firefox to start the SoundCloud download…" });
    } catch (_) { /* sidebar closed */ }
  }
  return undefined;
});
