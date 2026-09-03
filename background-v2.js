// The long-running report stays in the sidebar. This background page only
// opens it and supplies the same internal track batches that SoundCloud's web
// app requests. No SoundCloud developer API account or application key is
// required: the request template is observed from the signed-in page itself.

const TRACKS_ENDPOINT = "https://api-v2.soundcloud.com/tracks";
const TRACK_BATCH_SIZE = 30;
const REQUEST_CONTEXT_PREFIX = "soundcloudRequestContext:";
const memoryRequestContexts = new Map();

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

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "hydratePlaylistTracks") return hydratePlaylistTracks(message);
  return undefined;
});
