(() => {
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

  function addTrack(target, title, url, id = "") {
    if (!title || !url || !isTrackUrl(url)) return;
    const cleanTitle = String(title).replace(/\s+/g, " ").trim();
    if (cleanTitle) target.push({ id: id ? String(id) : "", title: cleanTitle, url: withPlaylistContext(url) });
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
    if (value.title && value.permalink_url) addTrack(found, value.title, value.permalink_url, value.id);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      walkForTracks(child, found, visited, depth + 1);
    }
  }

  function assignedJsonArray(source, marker) {
    const markerIndex = source.indexOf(marker);
    const start = source.indexOf("[", markerIndex);
    if (markerIndex === -1 || start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') {
        inString = true;
      } else if (character === "[") {
        depth += 1;
      } else if (character === "]") {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(source.slice(start, index + 1)); } catch (_) { return null; }
        }
      }
    }
    return null;
  }

  function hydrationObjects() {
    const objects = [];
    for (const script of document.scripts) {
      const source = script.textContent || "";
      if (script.type === "application/ld+json" || script.type === "application/json") {
        try { objects.push(JSON.parse(source)); } catch (_) { /* try other sources */ }
      }
      const hydration = assignedJsonArray(source, "__sc_hydration");
      if (hydration) objects.push(hydration);
    }
    return objects;
  }

  function primaryPlaylist(objects) {
    const candidates = [];
    const visited = new WeakSet();
    const currentPath = location.pathname.replace(/\/$/, "");

    function visit(value, hydratable = false) {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (!Array.isArray(value) && value.kind === "playlist" && Array.isArray(value.tracks)) {
        let routeMatch = false;
        try {
          const playlistPath = new URL(value.permalink_url || "", location.origin).pathname.replace(/\/$/, "");
          routeMatch = currentPath === playlistPath || currentPath.startsWith(`${playlistPath}/s-`);
        } catch (_) { /* rank by hydration marker and size */ }
        candidates.push({ value, hydratable, routeMatch });
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child?.hydratable === "playlist" && child.data) visit(child.data, true);
          else visit(child, hydratable);
        }
      } else {
        for (const child of Object.values(value)) visit(child, hydratable);
      }
    }

    for (const object of objects) visit(object);
    candidates.sort((left, right) => {
      const score = (candidate) => (candidate.routeMatch ? 1000000 : 0)
        + (candidate.hydratable ? 100000 : 0)
        + Number(candidate.value.track_count || candidate.value.tracks.length || 0);
      return score(right) - score(left);
    });
    const routeLooksLikePlaylist = /(?:^|\/)sets(?:\/|$)/i.test(currentPath);
    const matchingCandidate = candidates.find((candidate) => candidate.routeMatch);
    return (matchingCandidate || (!routeLooksLikePlaylist ? candidates[0] : null))?.value || null;
  }

  function apiRequestTemplate() {
    const entries = performance.getEntriesByType("resource").slice().reverse();
    for (const entry of entries) {
      try {
        const source = new URL(entry.name);
        if (source.hostname !== "api-v2.soundcloud.com" || !source.searchParams.has("client_id")) continue;
        const target = new URL("https://api-v2.soundcloud.com/tracks");
        for (const name of ["client_id", "app_version", "app_locale"]) {
          const value = source.searchParams.get(name);
          if (value) target.searchParams.set(name, value);
        }
        return target.href;
      } catch (_) { /* inspect the next resource */ }
    }
    return "";
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
    const playlistData = primaryPlaylist(objects);
    const domTracks = tracksFromDom();
    const dataTracks = playlistData ? tracksFromPageData([playlistData]) : tracksFromPageData(objects);
    const tracks = uniqueTracks([...dataTracks, ...domTracks]);
    const trackIds = playlistData?.tracks
      ?.map((track) => track?.id == null ? "" : String(track.id))
      .filter((id) => /^\d+$/.test(id)) || [];
    const embeddedCompleteTrackCount = playlistData?.tracks
      ?.filter((track) => track?.title && track?.permalink_url).length || 0;
    const template = apiRequestTemplate();
    const routeLooksLikePlaylist = /(?:^|\/)sets(?:\/|$)/i.test(location.pathname);
    const pageSaysPlaylist = /playlist/i.test(document.querySelector('meta[property="og:type"]')?.content || "");
    return {
      supported: routeLooksLikePlaylist || pageSaysPlaylist || tracks.length > 1,
      reason: "SoundCloud was reached, but this page was not recognized as a playlist.",
      title: playlistData?.title || document.querySelector("h1")?.textContent.trim() || document.title.replace(/^Stream | \|.*$/g, ""),
      tracks,
      trackIds,
      pageUrl: location.href,
      playlistContext: routeLooksLikePlaylist ? location.pathname.replace(/^\//, "") : "",
      apiTemplate: template,
      diagnostics: {
        page: sanitizedLocation(),
        readyState: document.readyState,
        routeLooksLikePlaylist,
        pageSaysPlaylist,
        domTrackCount: domTracks.length,
        dataTrackCount: dataTracks.length,
        uniqueTrackCount: tracks.length,
        declaredPlaylistTrackCount: playlistData?.track_count || null,
        embeddedPlaylistTrackCount: trackIds.length,
        embeddedCompleteTrackCount,
        apiRequestTemplateFound: Boolean(template),
        scriptCount: document.scripts.length,
        extensionVersion: browser.runtime.getManifest().version
      }
    };
  }

  // Expose one read-only function in Firefox's isolated extension world. The
  // popup invokes this directly with scripting.executeScript and receives its
  // structured result without relying on a runtime message response.
  window.__soundcloudPlaylistReportV2Inspect = inspectPage;

  console.info("[SoundCloud Playlist Report] scanner v2 loaded", sanitizedLocation());
})();
