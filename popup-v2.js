const status = document.querySelector("#status");
const scanProgress = document.querySelector("#scan-progress");
const scanProgressBar = document.querySelector("#scan-progress-bar");
const scanProgressCount = document.querySelector("#scan-progress-count");
const scanButton = document.querySelector("#scan");
const copyButton = document.querySelector("#copy");
const report = document.querySelector("#report");
const diagnostics = document.querySelector("#diagnostics");
const debugOutput = document.querySelector("#debug-output");
const copyDebugButton = document.querySelector("#copy-debug");
const reportBody = report.querySelector("tbody");
const settingsForm = document.querySelector("#settings-form");
const saveSettingsButton = document.querySelector("#save-settings");
const settingsStatus = document.querySelector("#settings-status");
let latestResults = [];
let debugLog = {};
const bandcampRunStates = new Map();
const downloadButtonsByRunId = new Map();
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = Object.freeze({
  gateEmail: "",
  gateName: "",
  gateComment: "",
  bandcampEmail: "",
  bandcampFileType: "mp3-v0",
  autoCloseTabs: false,
  tabTimeout: 30000
});
const BANDCAMP_FILE_TYPES = new Set([
  "mp3-v0", "mp3-320", "flac", "aac", "ogg-vorbis", "alac", "wav", "aiff"
]);
const REQUIRED_ORIGINS = [
  "https://bandcamp.com/*",
  "https://*.bandcamp.com/*"
];

function normalizedSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const timeout = Number.isInteger(source.tabTimeout) && source.tabTimeout >= 0
    ? source.tabTimeout
    : DEFAULT_SETTINGS.tabTimeout;
  return {
    gateEmail: typeof source.gateEmail === "string" ? source.gateEmail : DEFAULT_SETTINGS.gateEmail,
    gateName: typeof source.gateName === "string" ? source.gateName : DEFAULT_SETTINGS.gateName,
    gateComment: typeof source.gateComment === "string" ? source.gateComment : DEFAULT_SETTINGS.gateComment,
    bandcampEmail: typeof source.bandcampEmail === "string" ? source.bandcampEmail : DEFAULT_SETTINGS.bandcampEmail,
    bandcampFileType: BANDCAMP_FILE_TYPES.has(source.bandcampFileType)
      ? source.bandcampFileType
      : DEFAULT_SETTINGS.bandcampFileType,
    autoCloseTabs: source.autoCloseTabs === true,
    tabTimeout: timeout
  };
}

function settingsFromForm() {
  const formData = new FormData(settingsForm);
  return normalizedSettings({
    gateEmail: formData.get("gateEmail"),
    gateName: formData.get("gateName"),
    gateComment: formData.get("gateComment"),
    bandcampEmail: formData.get("bandcampEmail"),
    bandcampFileType: formData.get("bandcampFileType"),
    autoCloseTabs: formData.get("autoCloseTabs") === "on",
    tabTimeout: Number(formData.get("tabTimeout"))
  });
}

function fillSettingsForm(settings) {
  settingsForm.elements.gateEmail.value = settings.gateEmail;
  settingsForm.elements.gateName.value = settings.gateName;
  settingsForm.elements.gateComment.value = settings.gateComment;
  settingsForm.elements.bandcampEmail.value = settings.bandcampEmail;
  settingsForm.elements.bandcampFileType.value = settings.bandcampFileType;
  settingsForm.elements.autoCloseTabs.checked = settings.autoCloseTabs;
  settingsForm.elements.tabTimeout.value = settings.tabTimeout;
}

function showSettingsStatus(message, { error = false } = {}) {
  settingsStatus.textContent = message;
  settingsStatus.classList.toggle("error", error);
}

async function loadSettings() {
  try {
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    fillSettingsForm(normalizedSettings(stored[SETTINGS_KEY]));
  } catch (error) {
    showSettingsStatus(`Could not load settings: ${error.message}`, { error: true });
  }
}

fillSettingsForm(DEFAULT_SETTINGS);

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!settingsForm.reportValidity()) return;

  const settings = settingsFromForm();
  saveSettingsButton.disabled = true;
  showSettingsStatus("Saving…");
  try {
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
    showSettingsStatus("Settings saved");
  } catch (error) {
    showSettingsStatus(`Could not save settings: ${error.message}`, { error: true });
  } finally {
    saveSettingsButton.disabled = false;
  }
});

void loadSettings();

function showProgress(current, total) {
  scanProgressBar.max = total;
  scanProgressBar.value = current;
  scanProgressCount.textContent = `${current}/${total}`;
  status.hidden = true;
  scanProgress.hidden = false;
}

function hideProgress() {
  scanProgress.hidden = true;
  status.hidden = false;
}

function setDebug(step, value) {
  debugLog[step] = value;
  debugOutput.textContent = JSON.stringify(debugLog, null, 2);
}

function safeTabUrl(value) {
  try {
    const url = new URL(value);
    url.search = url.search ? "?<redacted>" : "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/s-[A-Za-z0-9_-]+(?=\/|$)/g, "/s-<redacted>");
    return url.href;
  } catch (_) {
    return value || "unavailable";
  }
}

function runIdFor(source, index, logIndex) {
  return `${source}:${index}:${logIndex}`;
}

function setPillContent(pill, iconClass, label) {
  const icon = document.createElement("i");
  icon.className = `pill__icon ${iconClass}`;
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "pill__label";
  text.textContent = label;
  pill.replaceChildren(icon, text);
}

function applyBandcampRunState(runId) {
  const pill = downloadButtonsByRunId.get(runId);
  if (!pill) return;
  const detail = bandcampRunStates.get(runId) || { state: "ready", message: "" };
  pill.className = "pill pill--download";
  pill.disabled = false;
  if (detail.state === "opening" || detail.state === "selecting-format" || detail.state === "processing") {
    pill.classList.add("pill--busy");
    pill.disabled = true;
    pill.title = detail.message || "Preparing Bandcamp download…";
    pill.setAttribute("aria-label", pill.title);
    setPillContent(pill, "fa-solid fa-spinner fa-spin", "Processing…");
    return;
  }
  if (detail.state === "started") {
    pill.classList.add("pill--started");
    pill.disabled = true;
    pill.title = detail.message || "Bandcamp download started";
    pill.setAttribute("aria-label", pill.title);
    setPillContent(pill, "fa-solid fa-check", "Finished");
    return;
  }
  if (detail.state === "sent-email") {
    pill.classList.add("pill--started");
    pill.disabled = true;
    pill.title = detail.message || "Bandcamp will send the download link by email.";
    pill.setAttribute("aria-label", pill.title);
    setPillContent(pill, "fa-solid fa-envelope", "Email sent");
    return;
  }
  if (detail.state === "failed") {
    pill.classList.add("pill--negative");
    pill.title = detail.message || "Bandcamp download failed. Click to retry.";
    pill.setAttribute("aria-label", pill.title);
    setPillContent(pill, "fa-solid fa-ban", "Failed");
    return;
  }
  pill.classList.add("pill--positive");
  pill.title = "Start auto download.";
  pill.setAttribute("aria-label", pill.title);
  setPillContent(pill, "fa-solid fa-download", "Download");
}

function render(results) {
  downloadButtonsByRunId.clear();
  reportBody.replaceChildren(...results.map((item, index) => {
    const row = document.createElement("tr");
    const number = document.createElement("td");
    number.textContent = index + 1;
    const titleCell = document.createElement("td");
    const track = document.createElement("a");
    track.className = "track";
    track.href = item.url;
    track.target = "_blank";
    track.textContent = item.title;
    track.title = item.title;
    titleCell.append(track);
    const logCell = document.createElement("td");
    const logList = document.createElement("div");
    logList.className = "log-list";
    const logs = item.logs || [{ label: "Download unavailable", iconClass: "fa-solid fa-ban", variant: "negative" }];
    logs.forEach((log) => {
      const pill = document.createElement(log.url ? "a" : "span");
      pill.className = `pill ${log.variant === "negative" ? "pill--negative" : "pill--positive"}`;
      pill.title = log.label;
      pill.setAttribute("aria-label", log.label);
      if (log.iconClass) {
        const icon = document.createElement("i");
        icon.className = `pill__icon ${log.iconClass}`;
        icon.setAttribute("aria-hidden", "true");
        pill.append(icon);
      } else {
        pill.textContent = log.label;
      }
      if (log.url) {
        pill.href = log.url;
        pill.target = "_blank";
        pill.rel = "noopener noreferrer";
      }
      logList.append(pill);
    });
    logCell.append(logList);
    const downloadCell = document.createElement("td");
    const downloadList = document.createElement("div");
    downloadList.className = "log-list";
    logs.forEach((log, logIndex) => {
      if (!log.url) return;
      if (log.label === "Soundcloud") {
        const runId = runIdFor("soundcloud", index, logIndex);
        const pill = document.createElement("button");
        pill.type = "button";
        pill.dataset.runId = runId;
        pill.dataset.soundcloudTrackUrl = log.trackUrl || item.url;
        downloadButtonsByRunId.set(runId, pill);
        applyBandcampRunState(runId);
        downloadList.append(pill);
        return;
      }
      if (log.label === "Bandcamp (paid)") {
        const paidPill = document.createElement("a");
        paidPill.className = "pill pill--positive pill--paid";
        paidPill.href = log.url;
        paidPill.target = "_blank";
        paidPill.rel = "noopener noreferrer";
        paidPill.title = "Open Bandcamp purchase page.";
        paidPill.setAttribute("aria-label", paidPill.title);
        setPillContent(paidPill, "fa-solid fa-lock", log.price || "View price");
        downloadList.append(paidPill);
        return;
      }
      if (log.label !== "Bandcamp (free)") return;
      const runId = runIdFor("bandcamp-free", index, logIndex);
      const pill = document.createElement("button");
      pill.type = "button";
      pill.dataset.runId = runId;
      pill.dataset.bandcampUrl = log.url;
      downloadButtonsByRunId.set(runId, pill);
      applyBandcampRunState(runId);
      downloadList.append(pill);
    });
    downloadCell.append(downloadList);
    row.append(number, titleCell, logCell, downloadCell);
    return row;
  }));
  report.hidden = false;
}

reportBody.addEventListener("click", async (event) => {
  const pill = event.target.closest("button.pill--download");
  if (!pill || pill.disabled) return;
  const { runId, bandcampUrl, soundcloudTrackUrl } = pill.dataset;
  if (!runId || (!bandcampUrl && !soundcloudTrackUrl)) return;

  if (soundcloudTrackUrl) {
    bandcampRunStates.set(runId, { state: "opening", message: "Opening SoundCloud in a background tab…" });
    applyBandcampRunState(runId);
    try {
      const result = await browser.runtime.sendMessage({ type: "startSoundcloudDownload", runId, trackUrl: soundcloudTrackUrl });
      if (!result?.started) throw new Error("SoundCloud download did not start.");
    } catch (error) {
      bandcampRunStates.set(runId, { state: "failed", message: error.message || "SoundCloud download failed. Click to retry." });
      applyBandcampRunState(runId);
    }
    return;
  }

  // Firefox only permits requesting optional hosts in the direct user-gesture
  // turn. A scanned report can outlive a previous denial or extension reload.
  const permissionRequest = browser.permissions.request({ origins: REQUIRED_ORIGINS });
  bandcampRunStates.set(runId, { state: "opening", message: "Opening Bandcamp in a background tab…" });
  applyBandcampRunState(runId);
  try {
    if (!(await permissionRequest)) {
      throw new Error("Bandcamp access was not granted. Click the Download pill again and allow access when Firefox asks.");
    }
    const result = await browser.runtime.sendMessage({ type: "startBandcampFreeDownload", runId, url: bandcampUrl });
    if (result?.duplicate) return;
    if (!result?.started) throw new Error("Bandcamp download did not start.");
  } catch (error) {
    bandcampRunStates.set(runId, { state: "failed", message: error.message || "Bandcamp download failed. Click to retry." });
    applyBandcampRunState(runId);
  }
});

browser.runtime.onMessage.addListener((message) => {
  if ((message?.type !== "bandcampDownloadProgress" && message?.type !== "soundcloudDownloadProgress") || typeof message.runId !== "string") return undefined;
  bandcampRunStates.set(message.runId, { state: message.state, message: message.message || "" });
  applyBandcampRunState(message.runId);
  return undefined;
});

async function reachScanner(tabId) {
  const injectionResults = await browser.scripting.executeScript({
    target: { tabId },
    files: ["scanner-v2.js", "scanner-probe-v2.js"]
  });
  const topFrame = injectionResults.find((entry) => entry.frameId === 0) || injectionResults[0];
  setDebug("directInjection", {
    resultCount: injectionResults.length,
    frameId: topFrame?.frameId,
    hasResult: Boolean(topFrame?.result)
  });
  if (topFrame?.error) throw new Error(`Page scanner failed: ${topFrame.error.message || topFrame.error}`);
  return topFrame?.result;
}

function withPlaylistContext(value, context) {
  const url = new URL(value);
  url.hash = "";
  if (context) url.searchParams.set("in", context);
  return url.href;
}

function orderedHydratedTracks(playlist, hydratedTracks) {
  const embeddedById = new Map(
    playlist.tracks.filter((track) => track.id).map((track) => [String(track.id), track])
  );
  const metadataById = new Map(
    hydratedTracks.filter((track) => track.id).map((track) => [String(track.id), track])
  );

  return playlist.trackIds.map((id, index) => {
    const metadata = metadataById.get(String(id));
    const embedded = embeddedById.get(String(id));
    const title = metadata?.title || embedded?.title || `Unavailable track ${index + 1}`;
    const sourceUrl = metadata?.permalink_url || embedded?.url || playlist.pageUrl;
    let url = sourceUrl;
    try { url = withPlaylistContext(sourceUrl, playlist.playlistContext); } catch (_) { /* use source URL */ }

    if (!metadata && !embedded) {
      return { id: String(id), title, url, unavailableReason: "Download unavailable" };
    }
    return {
      id: String(id),
      title,
      url,
      soundcloudMetadata: metadata || null
    };
  });
}

async function hydratePlaylistSnapshot(playlist, tabId) {
  if (!playlist.trackIds?.length) {
    setDebug("trackSnapshot", { source: "page tracks", trackCount: playlist.tracks.length });
    return playlist.tracks.map((track) => ({ ...track }));
  }

  status.textContent = `Loading metadata for ${playlist.trackIds.length} tracks…`;
  const hydrated = await browser.runtime.sendMessage({
    type: "hydratePlaylistTracks",
    tabId,
    trackIds: playlist.trackIds,
    apiTemplate: playlist.apiTemplate
  });
  if (!hydrated || !Array.isArray(hydrated.tracks)) {
    throw new Error("The SoundCloud metadata loader returned no response.");
  }
  setDebug("soundCloudMetadata", hydrated.diagnostics || { returnedTrackCount: hydrated.tracks.length });
  return orderedHydratedTracks(playlist, hydrated.tracks);
}

scanButton.addEventListener("click", async () => {
  // Invoke this before awaiting anything else: Firefox only permits a runtime
  // permission request directly inside the user's click handler.
  const permissionRequest = browser.permissions.request({ origins: REQUIRED_ORIGINS });
  // Start this lookup in the same click turn. Later tab switches must not retarget
  // a scan that is already in progress.
  const activeTabRequest = browser.tabs.query({ active: true, currentWindow: true });
  scanButton.disabled = true;
  copyButton.hidden = true;
  diagnostics.hidden = true;
  hideProgress();
  reportBody.replaceChildren();
  report.hidden = true;
  bandcampRunStates.clear();
  downloadButtonsByRunId.clear();
  debugLog = { extensionVersion: browser.runtime.getManifest().version };
  try {
    const hostPermissionGranted = await permissionRequest;
    setDebug("hostPermission", { granted: hostPermissionGranted, origins: REQUIRED_ORIGINS });
    if (!hostPermissionGranted) {
      throw new Error("Bandcamp access was not granted. Click Scan playlist and allow access when Firefox asks.");
    }
    const tabs = await activeTabRequest;
    const tab = tabs[0];
    if (!tab) throw new Error("Firefox did not return an active tab.");
    setDebug("activeTab", { id: tab.id, url: safeTabUrl(tab.url) });

    const playlist = await reachScanner(tab.id);
    setDebug("pageScanner", playlist?.diagnostics || "No response");
    if (!playlist) throw new Error("The SoundCloud page scanner returned no response.");
    if (!playlist.supported) throw new Error(`${playlist.reason} Detected page: ${playlist.diagnostics?.page || "unknown"}`);
    const privatePlaylistDetected = playlist.diagnostics?.routeLooksLikePlaylist
      && playlist.diagnostics?.pageSaysPlaylist
      && playlist.diagnostics?.embeddedPlaylistTrackCount === 0
      && playlist.diagnostics?.declaredPlaylistTrackCount == null
      && playlist.tracks.length > 0;
    if (privatePlaylistDetected) {
      throw new Error("Private playlist detected! Make sure to set your playlists to public before using the tool.");
    }
    if (!playlist.trackIds?.length && !playlist.tracks.length) {
      throw new Error("Playlist detected, but no embedded track IDs or track rows were found.");
    }

    // Prefer SoundCloud's complete embedded ID list; use page tracks only
    // for non-standard playlist pages that do not expose that full list.
    const trackSnapshot = await hydratePlaylistSnapshot(playlist, tab.id);
    showProgress(0, trackSnapshot.length);
    latestResults = await globalThis.TrackInspector.inspectTracks(trackSnapshot, ({ completed, total, track }) => {
      showProgress(track ? completed + 1 : completed, total);
    });
    if (!Array.isArray(latestResults)) throw new Error("The sidebar track checker did not return a result list.");
    setDebug("sidebarInspector", { requested: trackSnapshot.length, returned: latestResults.length, targetTabId: tab.id });
    render(latestResults);
    hideProgress();
    status.textContent = `${playlist.title}: ${latestResults.length} tracks checked.`;
    copyButton.hidden = false;
  } catch (error) {
    setDebug("error", { name: error.name, message: error.message, stack: error.stack });
    hideProgress();
    status.textContent = error.message;
    diagnostics.hidden = false;
    diagnostics.open = true;
  } finally {
    scanButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  const text = latestResults.map((item, index) => {
    const logs = (item.logs || []).map((log) => `${log.label}${log.url ? ` (${log.url})` : ""}`).join(", ");
    return `${index + 1}. ${item.title} — ${logs} — ${item.url}`;
  }).join("\n");
  await navigator.clipboard.writeText(text);
  copyButton.textContent = "Copied";
  setTimeout(() => { copyButton.textContent = "Copy report"; }, 1200);
});

copyDebugButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(debugOutput.textContent);
  copyDebugButton.textContent = "Copied";
  setTimeout(() => { copyDebugButton.textContent = "Copy diagnostics"; }, 1200);
});
