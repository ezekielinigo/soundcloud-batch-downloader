(() => {
  if (typeof window.__soundcloudPlaylistReportV2Inspect !== "function") {
    throw new Error("Scanner loaded without exposing its inspection function.");
  }
  return window.__soundcloudPlaylistReportV2Inspect();
})();
