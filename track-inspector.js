(() => {
  const ICON_CLASSES = Object.freeze({
    soundcloud: "fa-brands fa-soundcloud",
    droploud: "fa-solid fa-d",
    hypeddit: "fa-solid fa-h",
    pumpyoursound: "fa-solid fa-p",
    bandcamp: "fa-solid fa-b"
  });

  const STATUS_ICONS = Object.freeze({
    restricted: "fa-solid fa-earth-americas",
    unavailable: "fa-solid fa-ban"
  });

  const linkPatterns = {
    bandcamp: /https:\/\/[a-z0-9-]+\.bandcamp\.com\/(?:track|album)\/[^/?#\s"'<>()\\]+(?=$|[?#\s"'<>()\[\]{}.,;!])/ig,
    hypeddit: /https:\/\/hypeddit\.com\/[^/?#\s"'<>()\\]+(?:\/[^/?#\s"'<>()\\]+)?(?=$|[?#\s"'<>()\[\]{}.,;!])/ig,
    droploud: /https:\/\/droploud\.com\/(?:track|gate)\/[^/?#\s"'<>()\\]+(?=$|[?#\s"'<>()\[\]{}.,;!])/ig,
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

  function isDroploudUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:"
        && parsed.hostname === "droploud.com"
        && /^\/(?:track|gate)\/[^/]+\/?$/i.test(parsed.pathname);
    } catch (_) { return false; }
  }

  function restrictedLog() {
    return { label: "Region restricted", iconClass: STATUS_ICONS.restricted, variant: "negative" };
  }

  function unavailableLog() {
    return { label: "Download unavailable", iconClass: STATUS_ICONS.unavailable, variant: "negative" };
  }

  function hasRegionalRestriction(html) {
    const normalized = decodeHtml(html).replace(/\\n/g, "\n");
    return /this\s+track\s+is\s+not\s+available\s+in\s+[^<"\n]{2,80}/i.test(normalized);
  }

  function firstBandcampRelease(links) {
    return links.find((url) => isBandcampReleaseUrl(url) && /\/track\//i.test(new URL(url).pathname))
      || links.find(isBandcampReleaseUrl);
  }

  function normalizedTitle(value, { removeParenthetical = false } = {}) {
    let title = String(value || "");
    if (removeParenthetical) title = title.replace(/[\[(][^\])]*[\])]/g, " ");
    return title.normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function levenshteinDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row += 1) {
      const current = [row];
      for (let column = 1; column <= right.length; column += 1) {
        current[column] = left[row - 1] === right[column - 1]
          ? previous[column - 1]
          : 1 + Math.min(previous[column], current[column - 1], previous[column - 1]);
      }
      previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
  }

  function titleSimilarity(left, right) {
    const fullLeft = normalizedTitle(left);
    const fullRight = normalizedTitle(right);
    const baseLeft = normalizedTitle(left, { removeParenthetical: true });
    const baseRight = normalizedTitle(right, { removeParenthetical: true });
    const score = (first, second) => {
      if (!first || !second) return 0;
      return 1 - (levenshteinDistance(first, second) / Math.max(first.length, second.length));
    };
    return Math.max(score(fullLeft, fullRight), score(baseLeft, baseRight));
  }

  function bandcampPrice(document) {
    const purchase = document.querySelector("button.download-link.buy-link, .download-link.buy-link");
    const text = [purchase?.parentElement?.textContent, document.body?.textContent]
      .filter(Boolean)
      .map((value) => value.replace(/\s+/g, " ").trim())
      .join(" ");
    const match = text.match(/buy\s+digital\s+(?:track|album)\s+([€£¥$]?\s*\d+(?:[.,]\d+)?)\s*(USD|EUR|GBP|CAD|AUD|NZD|JPY|PHP|BRL|MXN)\b/i)
      || text.match(/([€£¥$]?\s*\d+(?:[.,]\d+)?)\s*(USD|EUR|GBP|CAD|AUD|NZD|JPY|PHP|BRL|MXN)\b/i);
    if (!match) return "";
    const rawAmount = match[1].replace(/[^\d.,]/g, "");
    const normalizedAmount = rawAmount.includes(",") && !rawAmount.includes(".") && /,\d{1,2}$/.test(rawAmount)
      ? rawAmount.replace(",", ".")
      : rawAmount.replace(/,/g, "");
    const amount = Number(normalizedAmount);
    return Number.isFinite(amount) ? `${match[2].toUpperCase()} ${amount.toFixed(2)}` : "";
  }

  function resolveAlbumTrack(document, albumUrl, soundcloudTitle) {
    const candidates = [...document.querySelectorAll("#track_table.track_list.track_table td.title-col a[href*='/track/']")]
      .map((anchor) => ({
        title: anchor.querySelector(".track-title")?.textContent?.trim() || anchor.textContent?.trim() || "",
        url: new URL(anchor.getAttribute("href"), albumUrl).href
      }))
      .filter((candidate) => isBandcampReleaseUrl(candidate.url) && /\/track\//i.test(new URL(candidate.url).pathname))
      .map((candidate) => ({ ...candidate, score: titleSimilarity(soundcloudTitle, candidate.title) }))
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.score >= 0.9 ? candidates[0] : null;
  }

  async function classifyBandcamp(url, soundcloudTitle) {
    try {
      const response = await fetch(url, { credentials: "omit", redirect: "follow" });
      if (!response.ok) throw new Error(`Bandcamp returned ${response.status}`);
      const html = await response.text();
      const document = new DOMParser().parseFromString(html, "text/html");
      let resolvedUrl = response.url || url;
      if (/\/album\//i.test(new URL(resolvedUrl).pathname)) {
        const resolved = resolveAlbumTrack(document, resolvedUrl, soundcloudTitle);
        if (!resolved) {
          return { label: "Bandcamp (no track match)", iconClass: STATUS_ICONS.unavailable, variant: "negative", url };
        }
        resolvedUrl = resolved.url;
        const trackResponse = await fetch(resolvedUrl, { credentials: "omit", redirect: "follow" });
        if (!trackResponse.ok) throw new Error(`Bandcamp track returned ${trackResponse.status}`);
        const trackHtml = await trackResponse.text();
        return classifyBandcampDocument(new DOMParser().parseFromString(trackHtml, "text/html"), trackResponse.url || resolvedUrl);
      }
      return classifyBandcampDocument(document, resolvedUrl);
    } catch (_) {
      return { label: "Bandcamp (paid)", iconClass: ICON_CLASSES.bandcamp, url };
    }
  }

  function classifyBandcampDocument(document, url) {
    const text = document.body?.textContent || "";
    if (/name\s*(?:your|ur)\s*price|pay\s+what\s+you\s+want/i.test(text)) {
      return { label: "Bandcamp (free)", iconClass: ICON_CLASSES.bandcamp, url };
    }
    return { label: "Bandcamp (paid)", iconClass: ICON_CLASSES.bandcamp, url, price: bandcampPrice(document) };
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
    const droploud = linksMatching(content, linkPatterns.droploud, isDroploudUrl);
    const pumpyoursound = uniqueLinks(content, linkPatterns.pumpyoursound);
    const logs = [];
    let soundcloudDownload = track.url;
    if (typeof downloadUrl === "string") {
      try { soundcloudDownload = new URL(downloadUrl, track.url).href; } catch (_) { /* use track page */ }
    }
    if (downloadable) logs.push({ label: "Soundcloud", iconClass: ICON_CLASSES.soundcloud, url: soundcloudDownload, trackUrl: track.url });
    for (const url of hypeddit) logs.push({ label: "Hypeddit", iconClass: ICON_CLASSES.hypeddit, url });
    for (const url of droploud) logs.push({ label: "Droploud", iconClass: ICON_CLASSES.droploud, url });
    for (const url of pumpyoursound) logs.push({ label: "Pumpyoursound", iconClass: ICON_CLASSES.pumpyoursound, url });
    const bandcampRelease = firstBandcampRelease(bandcamp);
    if (bandcampRelease) logs.push(await classifyBandcamp(bandcampRelease, track.title));
    if (!logs.length) logs.push(regionalRestriction ? restrictedLog() : unavailableLog());
    return { ...track, logs };
  }

  async function inspectTrack(track) {
    try {
      if (track.unavailableReason) return { ...track, logs: [unavailableLog()] };

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
        if (regionalRestriction) return { ...track, logs: [restrictedLog()] };
        throw new Error(`SoundCloud returned ${response.status}`);
      }

      return await inspectContent(track, html, {
        downloadable: valueFromTrackData(html, "downloadable") === true
          && valueFromTrackData(html, "has_downloads_left") !== false,
        downloadUrl: valueFromTrackData(html, "download_url"),
        regionalRestriction
      });
    } catch (error) {
      return { ...track, logs: [unavailableLog()], error: error.message };
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
