(() => {
  if (typeof window.__soundcloudPlaylistReportV2Inspect === "function") return;
  window.__soundcloudPlaylistReportV2Loaded = true;

  const absolute = (value) => {
    const url = new URL(value, location.origin);
    url.hash = "";
    return url.href;
  };

  function withPlaylistContext(value) {
    const url = new URL(value, location.origin);
    // SoundCloud renders playlist-specific track modules (including custom
    // monetization banners) when a track is opened with its `in` route query.
    // Keep the full current path so private playlist secret tokens survive too.
    if (/(?:^|\/)sets(?:\/|$)/i.test(location.pathname)) {
      url.searchParams.set("in", location.pathname.replace(/^\//, ""));
    }
    return absolute(url.href);
  }

  const isTrackUrl = (value) => {
    try {
      const url = new URL(value, location.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      if (!(url.hostname === "soundcloud.com" || url.hostname.endsWith(".soundcloud.com"))) return false;
      if (parts.length < 2 || parts[1] === "sets") return false;
      return !new Set(["you", "discover", "stream", "search", "upload", "settings", "pages"])
        .has(parts[0]);
    } catch (_) {
      return false;
    }
  };

  function addTrack(target, title, url) {
    if (!title || !url || !isTrackUrl(url)) return;
    const cleanTitle = String(title).replace(/\s+/g, " ").trim();
    if (cleanTitle) target.push({ title: cleanTitle, url: withPlaylistContext(url) });
  }

  function tracksFromDom() {
    const found = [];
    const selectors = [
      "a.soundTitle__title[href]",
      "a.trackItem__trackTitle[href]",
      ".trackList__item a[href]",
      "li[class*='track'] a[href]",
      "[role='listitem'] a[href]",
      "a[itemprop='url'][href]"
    ];
    for (const link of document.querySelectorAll(selectors.join(","))) {
      addTrack(found, link.getAttribute("title") || link.getAttribute("aria-label") || link.textContent, link.href);
    }
    return found;
  }

  function walkForTracks(value, found, visited, depth = 0) {
    if (!value || typeof value !== "object" || depth > 18 || visited.has(value)) return;
    visited.add(value);
    if (value.title && value.permalink_url) addTrack(found, value.title, value.permalink_url);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      walkForTracks(child, found, visited, depth + 1);
    }
  }

  function hydrationObjects() {
    const objects = [];
    for (const script of document.scripts) {
      const source = script.textContent || "";
      if (script.type === "application/ld+json" || script.type === "application/json") {
        try { objects.push(JSON.parse(source)); } catch (_) { /* try other sources */ }
      }
      const marker = source.indexOf("__sc_hydration");
      if (marker !== -1) {
        const start = source.indexOf("[", marker);
        const end = source.lastIndexOf("]");
        if (start !== -1 && end > start) {
          try { objects.push(JSON.parse(source.slice(start, end + 1))); } catch (_) { /* markup changed */ }
        }
      }
    }
    return objects;
  }

  function tracksFromPageData(objects) {
    const found = [];
    const visited = new WeakSet();
    for (const object of objects) walkForTracks(object, found, visited);
    return found;
  }

  function uniqueTracks(items) {
    const seen = new Set();
    return items.filter((track) => {
      const key = track.url.replace(/[?#].*$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function sanitizedLocation() {
    const url = new URL(location.href);
    url.search = url.search ? "?<redacted>" : "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/s-[A-Za-z0-9_-]+(?=\/|$)/g, "/s-<redacted>");
    return url.href;
  }

  function inspectPage() {
    const objects = hydrationObjects();
    const domTracks = tracksFromDom();
    const dataTracks = tracksFromPageData(objects);
    const tracks = uniqueTracks([...dataTracks, ...domTracks]);
    const routeLooksLikePlaylist = /(?:^|\/)sets(?:\/|$)/i.test(location.pathname);
    const pageSaysPlaylist = /playlist/i.test(document.querySelector('meta[property="og:type"]')?.content || "");
    return {
      supported: routeLooksLikePlaylist || pageSaysPlaylist || tracks.length > 1,
      reason: "SoundCloud was reached, but this page was not recognized as a playlist.",
      title: document.querySelector("h1")?.textContent.trim() || document.title.replace(/^Stream | \|.*$/g, ""),
      tracks,
      diagnostics: {
        page: sanitizedLocation(),
        readyState: document.readyState,
        routeLooksLikePlaylist,
        pageSaysPlaylist,
        domTrackCount: domTracks.length,
        dataTrackCount: dataTracks.length,
        uniqueTrackCount: tracks.length,
        scriptCount: document.scripts.length,
        extensionVersion: browser.runtime.getManifest().version
      }
    };
  }

  // Expose one read-only function in Firefox's isolated extension world. The
  // popup invokes this directly with scripting.executeScript and receives its
  // structured result without relying on a runtime message response.
  window.__soundcloudPlaylistReportV2Inspect = inspectPage;

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "diagnosePage" || message.type === "getPlaylistTracks") return inspectPage();
    return undefined;
  });

  console.info("[SoundCloud Playlist Report] scanner v2 loaded", sanitizedLocation());
})();
