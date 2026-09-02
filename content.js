(() => {
  if (window.__soundcloudPlaylistReportLoaded) return;
  window.__soundcloudPlaylistReportLoaded = true;

  const isPlaylistPage = () => /(?:^|\/)sets(?:\/|$)/.test(location.pathname);
  // Secret SoundCloud URLs can carry an access token in the query string or path.
  // Preserve it; dropping it would turn an accessible private track into a 401/404.
  const absolute = (url) => {
    const parsed = new URL(url, location.origin);
    parsed.hash = "";
    return parsed.href;
  };

  function tracksFromDom() {
    const seen = new Set();
    return [...document.querySelectorAll('a.soundTitle__title[href], a[href*="/sets/"] + a[href]')]
      .map((link) => ({ title: link.textContent.trim(), url: absolute(link.href) }))
      .filter((track) => track.title && /^https:\/\/soundcloud\.com\/[^/]+\/[^/]+/.test(track.url))
      .filter((track) => !track.url.includes("/sets/") && !seen.has(track.url) && seen.add(track.url));
  }

  // SoundCloud includes hydrated playlist objects in its HTML. This catches tracks
  // that may not have a rendered DOM row yet, while the DOM remains a useful fallback.
  function tracksFromHydration() {
    const source = document.documentElement.innerHTML;
    const matches = source.matchAll(/\{"hydratable":"(?:playlist|sound)","data":(\{.*?\})\}(?=<\/script>|,\{"hydratable")/g);
    const found = [];
    for (const match of matches) {
      try {
        const data = JSON.parse(match[1]);
        const sounds = data.tracks || (data.kind === "track" ? [data] : []);
        for (const sound of sounds) {
          if (sound.permalink_url && sound.title) found.push({ title: sound.title, url: absolute(sound.permalink_url) });
        }
      } catch (_) { /* Page markup can change; the DOM fallback still runs. */ }
    }
    const seen = new Set();
    return found.filter((track) => !seen.has(track.url) && seen.add(track.url));
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.type !== "getPlaylistTracks") return undefined;
    if (!isPlaylistPage()) return { supported: false, reason: "This is not a SoundCloud playlist URL." };
    const tracks = tracksFromHydration();
    const domTracks = tracksFromDom();
    const combined = [...tracks, ...domTracks];
    const seen = new Set();
    return {
      supported: true,
      title: document.querySelector("h1")?.textContent.trim() || document.title.replace(/^Stream | \|.*$/g, ""),
      tracks: combined.filter((track) => !seen.has(track.url) && seen.add(track.url))
    };
  });
})();
