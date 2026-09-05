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
const settingsDetails = document.querySelector("#settings");
const accountButtons = [...document.querySelectorAll(".account-button")];
const ACCOUNT_UI = Object.freeze({
  soundcloud: Object.freeze({ label: "SoundCloud", iconClass: "fa-brands fa-soundcloud" }),
  spotify: Object.freeze({ label: "Spotify", iconClass: "fa-brands fa-spotify" })
});
let accountRefreshGeneration = 0;
let latestResults = [];
let debugLog = {};
const downloadRunStates = new Map();
const downloadButtonsByRunId = new Map();
const SETTINGS_KEY = "settings";
const LOCAL_DEFAULT_SETTINGS_FILE = "default-settings.local.json";
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
const BANDCAMP_ORIGINS = [
  "https://bandcamp.com/*",
  "https://*.bandcamp.com/*"
];
const HYPEDDIT_ORIGINS = [
  "https://hypeddit.com/*",
  "https://www.hypeddit.com/*"
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

async function localDefaultSettings() {
  try {
    const response = await fetch(browser.runtime.getURL(LOCAL_DEFAULT_SETTINGS_FILE), { cache: "no-store" });
    if (!response.ok) return DEFAULT_SETTINGS;
    return normalizedSettings(await response.json());
  } catch (_) {
    return DEFAULT_SETTINGS;
  }
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
    if (stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object") {
      fillSettingsForm(normalizedSettings(stored[SETTINGS_KEY]));
      return;
    }
    const settings = await localDefaultSettings();
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
    fillSettingsForm(settings);
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

function accountButton(service) {
  return accountButtons.find((button) => button.dataset.service === service);
}

function renderAccount(account) {
  const button = accountButton(account.service);
  const metadata = ACCOUNT_UI[account.service];
  if (!button || !metadata) return;
  const statusText = account.state === "checking"
    ? "Checking…"
    : account.state === "signed-in"
      ? account.username
      : account.state === "signed-out"
        ? "Sign in"
        : "Unable to check";
  button.disabled = account.state === "checking";
  button.classList.toggle("account-button--signed-out", account.state === "signed-out");
  button.classList.toggle("account-button--error", account.state === "error");
  button.dataset.accountState = account.state;
  const icon = document.createElement("i");
  icon.className = metadata.iconClass;
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = `${statusText}`;
  button.replaceChildren(icon, label);
  button.setAttribute("aria-label", `${metadata.label} - ${statusText}`);
  button.title = account.state === "error"
    ? `${account.message || "Could not check this account."} Click to open the account-status page.`
    : account.state === "signed-in"
      ? `Open ${metadata.label}.`
      : account.state === "signed-out"
        ? `Open ${metadata.label} so you can sign in.`
        : `Checking ${metadata.label}…`;
}

async function refreshAccounts() {
  const generation = ++accountRefreshGeneration;
  accountButtons.forEach((button) => renderAccount({ service: button.dataset.service, state: "checking" }));
  try {
    const accounts = await browser.runtime.sendMessage({ type: "checkConnectedAccounts" });
    if (generation !== accountRefreshGeneration) return;
    if (!Array.isArray(accounts)) throw new Error("The account checker returned no result.");
    accounts.forEach(renderAccount);
  } catch (error) {
    if (generation !== accountRefreshGeneration) return;
    accountButtons.forEach((button) => {
      renderAccount({
        service: button.dataset.service,
        state: "error",
        message: error.message
      });
    });
  }
}

accountButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await browser.runtime.sendMessage({ type: "openConnectedAccount", service: button.dataset.service });
    } catch (error) {
      renderAccount({ service: button.dataset.service, state: "error", message: error.message });
    } finally {
      if (button.dataset.accountState !== "checking") button.disabled = false;
    }
  });
});

settingsDetails.addEventListener("toggle", () => {
  if (settingsDetails.open) void refreshAccounts();
});

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

function applyDownloadRunState(runId) {
  const pill = downloadButtonsByRunId.get(runId);
  if (!pill) return;
  const detail = downloadRunStates.get(runId) || { state: "ready", message: "" };
  pill.className = "pill pill--download";
  pill.disabled = false;
  if (detail.state === "queued") {
    pill.classList.add("pill--busy");
    pill.disabled = true;
    pill.title = detail.message || "Queued for download.";
    pill.setAttribute("aria-label", pill.title);
    setPillContent(pill, "fa-solid fa-clock", "Queued");
    return;
  }
  if (detail.state === "opening" || detail.state === "selecting-format" || detail.state === "processing") {
    pill.classList.add("pill--busy");
    pill.disabled = true;
    pill.title = detail.message || "Preparing download…";
    pill.setAttribute("aria-label", pill.title);
    setPillContent(pill, "fa-solid fa-spinner fa-spin", "Processing…");
    return;
  }
  if (detail.state === "downloading") {
    pill.classList.add("pill--busy");
    pill.disabled = true;
    pill.title = detail.message || "Firefox is downloading the file.";
    pill.setAttribute("aria-label", pill.title);
    setPillContent(pill, "fa-solid fa-spinner fa-spin", "Downloading…");
    return;
  }
  if (detail.state === "started" || detail.state === "finished") {
    pill.classList.add("pill--started");
    pill.disabled = true;
    pill.title = detail.message || "Download finished";
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
    pill.title = detail.message || "Download failed. Click to retry.";
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
        applyDownloadRunState(runId);
        downloadList.append(pill);
        return;
      }
      if (log.label === "Hypeddit") {
        const runId = runIdFor("hypeddit", index, logIndex);
        const pill = document.createElement("button");
        pill.type = "button";
        pill.dataset.runId = runId;
        pill.dataset.hypedditUrl = log.url;
        downloadButtonsByRunId.set(runId, pill);
        applyDownloadRunState(runId);
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
      applyDownloadRunState(runId);
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
  const { runId, bandcampUrl, soundcloudTrackUrl, hypedditUrl } = pill.dataset;
  if (!runId || (!bandcampUrl && !soundcloudTrackUrl && !hypedditUrl)) return;

  if (soundcloudTrackUrl) {
    downloadRunStates.set(runId, { state: "opening", message: "Opening SoundCloud in a background tab…" });
    applyDownloadRunState(runId);
    try {
      const result = await browser.runtime.sendMessage({ type: "startSoundcloudDownload", runId, trackUrl: soundcloudTrackUrl });
      if (!result?.started) throw new Error("SoundCloud download did not start.");
    } catch (error) {
      downloadRunStates.set(runId, { state: "failed", message: error.message || "SoundCloud download failed. Click to retry." });
      applyDownloadRunState(runId);
    }
    return;
  }

  if (hypedditUrl) {
    const permissionRequest = browser.permissions.request({ origins: HYPEDDIT_ORIGINS });
    downloadRunStates.set(runId, { state: "queued", message: "Requesting Hypeddit access…" });
    applyDownloadRunState(runId);
    try {
      if (!(await permissionRequest)) {
        throw new Error("Hypeddit access was not granted. Click the Download pill again and allow access when Firefox asks.");
      }
      const result = await browser.runtime.sendMessage({ type: "startHypedditDownload", runId, url: hypedditUrl });
      if (result?.duplicate) return;
      if (!result?.started) throw new Error("Hypeddit download did not start.");
    } catch (error) {
      downloadRunStates.set(runId, { state: "failed", message: error.message || "Hypeddit download failed. Click to retry." });
      applyDownloadRunState(runId);
    }
    return;
  }

  // Firefox only permits requesting optional hosts in the direct user-gesture
  // turn. A scanned report can outlive a previous denial or extension reload.
  const permissionRequest = browser.permissions.request({ origins: BANDCAMP_ORIGINS });
  downloadRunStates.set(runId, { state: "opening", message: "Opening Bandcamp in a background tab…" });
  applyDownloadRunState(runId);
  try {
    if (!(await permissionRequest)) {
      throw new Error("Bandcamp access was not granted. Click the Download pill again and allow access when Firefox asks.");
    }
    const result = await browser.runtime.sendMessage({ type: "startBandcampFreeDownload", runId, url: bandcampUrl });
    if (result?.duplicate) return;
    if (!result?.started) throw new Error("Bandcamp download did not start.");
  } catch (error) {
    downloadRunStates.set(runId, { state: "failed", message: error.message || "Bandcamp download failed. Click to retry." });
    applyDownloadRunState(runId);
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (!["bandcampDownloadProgress", "soundcloudDownloadProgress", "hypedditDownloadProgress"].includes(message?.type) || typeof message.runId !== "string") return undefined;
  downloadRunStates.set(message.runId, { state: message.state, message: message.message || "" });
  applyDownloadRunState(message.runId);
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
  const permissionRequest = browser.permissions.request({ origins: BANDCAMP_ORIGINS });
  // Start this lookup in the same click turn. Later tab switches must not retarget
  // a scan that is already in progress.
  const activeTabRequest = browser.tabs.query({ active: true, currentWindow: true });
  scanButton.disabled = true;
  copyButton.hidden = true;
  diagnostics.hidden = true;
  hideProgress();
  reportBody.replaceChildren();
  report.hidden = true;
  downloadRunStates.clear();
  downloadButtonsByRunId.clear();
  debugLog = { extensionVersion: browser.runtime.getManifest().version };
  try {
    const hostPermissionGranted = await permissionRequest;
    setDebug("hostPermission", { granted: hostPermissionGranted, origins: BANDCAMP_ORIGINS });
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
