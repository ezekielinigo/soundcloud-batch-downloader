const status = document.querySelector("#status");
const scanButton = document.querySelector("#scan");
const copyButton = document.querySelector("#copy");
const report = document.querySelector("#report");
let latestResults = [];

function isSoundCloudUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "soundcloud.com" || url.hostname.endsWith(".soundcloud.com"));
  } catch (_) {
    return false;
  }
}

function render(results) {
  report.replaceChildren(...results.map((item) => {
    const row = document.createElement("li");
    const track = document.createElement("a");
    track.className = "track";
    track.href = item.url;
    track.target = "_blank";
    track.textContent = item.title;
    const outcome = document.createElement("span");
    outcome.className = item.report === "Downloads disabled" ? "result none" : "result";
    outcome.textContent = item.report;
    row.append(track, outcome);
    for (const url of item.links) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.textContent = url;
      row.append(document.createElement("br"), link);
    }
    return row;
  }));
}

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  copyButton.hidden = true;
  report.replaceChildren();
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!isSoundCloudUrl(tab.url || "")) {
      throw new Error("Open a SoundCloud playlist first.");
    }
    let playlist;
    try {
      playlist = await browser.tabs.sendMessage(tab.id, { type: "getPlaylistTracks" });
    } catch (_) {
      // A page already open when the add-on was installed has no content script.
      // Inject it here so the user does not need to reload the playlist first.
      await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      playlist = await browser.tabs.sendMessage(tab.id, { type: "getPlaylistTracks" });
    }
    if (!playlist?.supported) throw new Error(playlist?.reason || "Open a SoundCloud playlist first.");
    if (!playlist.tracks.length) throw new Error("No tracks are loaded yet. Scroll through the playlist, then try again.");
    status.textContent = `Checking ${playlist.tracks.length} tracks…`;
    latestResults = await browser.runtime.sendMessage({ type: "inspectTracks", tracks: playlist.tracks });
    render(latestResults);
    status.textContent = `${playlist.title}: ${latestResults.length} tracks checked.`;
    copyButton.hidden = false;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    scanButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  const text = latestResults.map((item, index) => {
    const links = item.links.length ? ` — ${item.links.join(", ")}` : "";
    return `${index + 1}. ${item.title} — ${item.report}${links} — ${item.url}`;
  }).join("\n");
  await navigator.clipboard.writeText(text);
  copyButton.textContent = "Copied";
  setTimeout(() => { copyButton.textContent = "Copy report"; }, 1200);
});
