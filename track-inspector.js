(() => {
  const linkPatterns = {
    bandcamp: /https:\/\/[a-z0-9-]+\.bandcamp\.com\/(?:track|album)\/[^/?#\s"'<>()\\]+(?=$|[?#\s"'<>()\[\]{}.,;!])/ig,
    hypeddit: /https:\/\/hypeddit\.com\/[^/?#\s"'<>()\\]+(?:\/[^/?#\s"'<>()\\]+)?(?=$|[?#\s"'<>()\[\]{}.,;!])/ig,
    droploud: /https:\/\/droploud\.com\/track\/[^/?#\s"'<>()\\]+(?=$|[?#\s"'<>()\[\]{}.,;!])/ig,
    pumpyoursound: /(?:https?:)?\/\/(?:www\.)?pumpyoursound\.com\/[^\s"'<>()]*/ig
  };

  function decodeHtml(value) {
    return value.replace(/&amp;/gi, "&").replace(/&#x2F;/gi, "/").replace(/&quot;/gi, '"');
  }

  function uniqueLinks(html, pattern) {
    const normalized = html.replace(/\\\//g, "/");
    return [...new Set((normalized.match(pattern) || []).map(decodeHtml).map((url) => url.replace(/[.,;!?]+$/, "")))];
  }

  function linksMatching(html, pattern, validator) {
    return uniqueLinks(html, pattern).filter(validator);
  }

  function anchorHrefs(html) {
    const normalized = html.replace(/\\\//g, "/");
    const hrefPattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/ig;
    const links = [];
    for (const match of normalized.matchAll(hrefPattern)) {
      const url = decodeHtml(match[2]).trim();
      if (/^https?:\/\//i.test(url)) links.push(url);
    }
    return [...new Set(links)];
  }

  function isBandcampReleaseUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:"
        && /^[^.]+\.bandcamp\.com$/i.test(parsed.hostname)
        && /^\/(track|album)\/[^/]+\/?$/i.test(parsed.pathname);
    } catch (_) { return false; }
  }

  function isHypedditUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:"
        && /^(?:www\.)?hypeddit\.com$/i.test(parsed.hostname)
        && /^\/[^/]+(?:\/[^/]+)?\/?$/.test(parsed.pathname);
    } catch (_) { return false; }
  }

  function isDroploudTrackUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:"
        && parsed.hostname === "droploud.com"
        && /^\/track\/[^/]+\/?$/i.test(parsed.pathname);
    } catch (_) { return false; }
  }

  function hasRegionalRestriction(html) {
    const normalized = decodeHtml(html).replace(/\\n/g, "\n");
    return /this\s+track\s+is\s+not\s+available\s+in\s+[^<"\n]{2,80}/i.test(normalized);
  }

  function firstBandcampRelease(links) {
    return links.find((url) => isBandcampReleaseUrl(url) && /\/track\//i.test(new URL(url).pathname))
      || links.find(isBandcampReleaseUrl);
  }

  async function classifyBandcamp(url) {
    try {
      const response = await fetch(url, { credentials: "omit", redirect: "follow" });
      if (!response.ok) throw new Error(`Bandcamp returned ${response.status}`);
      const html = await response.text();
      return /name\s*(?:your|ur)\s*price|pay\s+what\s+you\s+want/i.test(html)
        ? { label: "Bandcamp (free)", url }
        : { label: "Bandcamp (paid)", url };
    } catch (_) {
      return { label: "Bandcamp (paid)", url };
    }
  }

  function valueFromTrackData(html, key) {
    const quotedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(new RegExp(`"${quotedKey}":(true|false|"(?:[^"\\\\]|\\\\.)*")`, "i"));
    if (!match) return undefined;
    return match[1] === "true" ? true : match[1] === "false" ? false : JSON.parse(match[1]);
  }

  async function inspectContent(track, content, { downloadable = false, downloadUrl, regionalRestriction = false } = {}) {
    const bandcamp = [...new Set([
      ...anchorHrefs(content).filter(isBandcampReleaseUrl),
      ...uniqueLinks(content, linkPatterns.bandcamp)
    ])];
    const hypeddit = linksMatching(content, linkPatterns.hypeddit, isHypedditUrl);
    const droploud = linksMatching(content, linkPatterns.droploud, isDroploudTrackUrl);
    const pumpyoursound = uniqueLinks(content, linkPatterns.pumpyoursound);
    const logs = [];
    let soundcloudDownload = track.url;
    if (typeof downloadUrl === "string") {
      try { soundcloudDownload = new URL(downloadUrl, track.url).href; } catch (_) { /* use track page */ }
    }
    if (downloadable) logs.push({ label: "Soundcloud", url: soundcloudDownload });
    for (const url of hypeddit) logs.push({ label: "Hypeddit", url });
    for (const url of droploud) logs.push({ label: "Droploud", url });
    for (const url of pumpyoursound) logs.push({ label: "Pumpyoursound", url });
    const bandcampRelease = firstBandcampRelease(bandcamp);
    if (bandcampRelease) logs.push(await classifyBandcamp(bandcampRelease));
    if (!logs.length) logs.push({ label: regionalRestriction ? "Regional restrictions" : "Downloads disabled" });
    return { ...track, logs };
  }

  async function inspectTrack(track) {
    try {
      if (track.unavailableReason) return { ...track, logs: [{ label: track.unavailableReason }] };

      // Batch-hydrated records already contain the original description and
      // official-download flag. Using them avoids one extra SoundCloud page
      // request per track and lets the sidebar keep working in the background.
      if (track.soundcloudMetadata) {
        const metadata = track.soundcloudMetadata;
        const metadataText = [metadata.description, metadata.purchase_url].filter(Boolean).join("\n");
        return await inspectContent(track, metadataText, {
          downloadable: metadata.downloadable === true && metadata.has_downloads_left !== false,
          downloadUrl: metadata.download_url,
          regionalRestriction: metadata.policy === "BLOCK" || hasRegionalRestriction(metadataText)
        });
      }

      const response = await fetch(track.url, { credentials: "include" });
      const html = await response.text();
      const regionalRestriction = hasRegionalRestriction(html);
      if (!response.ok) {
        if (regionalRestriction) return { ...track, logs: [{ label: "Regional restrictions" }] };
        throw new Error(`SoundCloud returned ${response.status}`);
      }

      return await inspectContent(track, html, {
        downloadable: valueFromTrackData(html, "downloadable") === true
          && valueFromTrackData(html, "has_downloads_left") !== false,
        downloadUrl: valueFromTrackData(html, "download_url"),
        regionalRestriction
      });
    } catch (error) {
      return { ...track, logs: [{ label: "Downloads disabled" }], error: error.message };
    }
  }

  async function inspectTracks(tracks, onProgress = () => {}) {
    const results = [];
    for (let index = 0; index < tracks.length; index += 1) {
      onProgress({ completed: index, total: tracks.length, track: tracks[index] });
      results.push(await inspectTrack(tracks[index]));
    }
    onProgress({ completed: tracks.length, total: tracks.length });
    return results;
  }

  globalThis.TrackInspector = Object.freeze({ inspectTracks });
})();
