# SoundCloud Playlist Download Report

A Firefox sidebar extension that scans tracks in the open SoundCloud playlist and reports:

- `Soundcloud` — the track page declares an uploader-enabled SoundCloud download.
- `Hypeddit` / `Pumpyoursound` / `Droploud` — a matching link was found in the track metadata or description.
- `Bandcamp (free)` — Bandcamp’s public page contains a “name your price” signal.
- `Bandcamp (paid)` — a Bandcamp link was found without that signal.
- `Downloads disabled` — no supported download destination was detected.
- `Regional restrictions` — SoundCloud explicitly reported that the track is unavailable in a country.

The extension only reports publicly available metadata. It does not download media, bypass download gates, or submit third-party forms.

When scanning a playlist, track checks retain SoundCloud’s playlist context. This allows the report to see track-specific modules such as artist-customized purchase banners that SoundCloud does not always render on a plain standalone track URL.

For Bandcamp, the extension prioritizes the first `bandcamp.com/track/...` URL in a track’s delivered HTML. This includes artist-customized SoundCloud banners—even when their button text is not “Download” or the banner is visually hidden. If no track release exists, it falls back to the first Bandcamp album release, while ignoring profile and unrelated Bandcamp links.

External link matching is strict: Bandcamp must be a single track or album release URL, while Hypeddit may contain one or two path segments. Malformed URLs with an appended serialized newline or extra path segment are ignored rather than shortened into a misleading destination.

Link matching is deliberately strict: Bandcamp URLs must be `https://artist.bandcamp.com/track/slug` or `/album/slug`, and Hypeddit URLs must be `https://hypeddit.com/artist/slug`. This prevents line-break remnants such as `/n/nDownload` from becoming part of a destination.

It can also scan a private playlist when you are already signed in to SoundCloud in the same Firefox profile and can open that playlist normally. It preserves SoundCloud secret URLs and uses your existing session only for those checks; it does not bypass private-access controls or share credentials.

## Load it in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `manifest.json` from this folder.
4. Click the extension toolbar button to open its persistent sidebar. Open a public `soundcloud.com/<user>/sets/<playlist>` page (including the `www.soundcloud.com` version), scroll through any lazy-loaded tracks, then choose **Scan playlist**. The sidebar keeps the report visible while you browse the playlist.
5. On the first scan, approve Firefox’s request for SoundCloud and Bandcamp access. The extension requests these hosts from the Scan button because a persistent sidebar can outlive Firefox’s temporary active-tab permission.

Use **Copy report** to place the final list on the clipboard.

If scanning fails, the popup opens a **Diagnostics** section. Use **Copy diagnostics** and share that output when reporting a problem. Secret query parameters and SoundCloud `/s-...` tokens are redacted from the diagnostic URL.

If diagnostics say “Receiving end does not exist,” reload the temporary add-on after updating it. The background scanner must be started for the sidebar to inspect track pages.

The page scanner is injected only when **Scan playlist** is clicked. The resulting track list is copied into a fixed snapshot, and all long-running track checks happen inside the persistent sidebar. Switching tabs or lazy-loading more playlist rows therefore does not retarget or mutate a scan already in progress.

## Notes

- SoundCloud’s page markup changes regularly; this uses both the rendered track list and its hydrated page data as fallbacks.
- Tracks not yet loaded by SoundCloud cannot be discovered. Scroll to the end of long playlists before scanning.
- A track may show several pills—for example, an official SoundCloud download and a Bandcamp link—so you can choose the source you want to open.
