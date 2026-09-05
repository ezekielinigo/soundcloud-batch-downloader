# SoundCloud Playlist Download Report

A Firefox sidebar extension that scans tracks in the open SoundCloud playlist and reports:

- `Soundcloud` — SoundCloud reports an uploader-enabled download with remaining download allowance.
- `Hypeddit` / `Pumpyoursound` / `Droploud` — a matching link was found in the track metadata or description.
- `Bandcamp (free)` — Bandcamp’s public page contains a “name your price” signal.
- `Bandcamp (paid)` — a Bandcamp link was found without that signal.
- `Downloads disabled` — no supported download destination was detected.
- `Regional restrictions` — SoundCloud explicitly reported that the track is unavailable in a country.

The extension only reports metadata that the open SoundCloud page is allowed to access. A user can explicitly start supported downloads from the **DOWNLOAD** column. For Hypeddit, it activates the final Download control already present in the gate page; it does not automate follows, comments, logins, email forms, or CAPTCHAs. Bandcamp automation is limited to its free/name-your-price download flow.

Long playlists do not need to be scrolled first. SoundCloud embeds the complete ordered track-ID list in the playlist page, then requests complete track records in batches as rows become visible. The extension reads that embedded order and makes equivalent internal web-app requests in batches of 30. This does not use SoundCloud's developer API, require a developer application, or require a Pro account.

When scanning a playlist, track checks retain SoundCloud’s playlist context. This allows the report to see track-specific modules such as artist-customized purchase banners that SoundCloud does not always render on a plain standalone track URL.

For Bandcamp, the extension prioritizes the first `bandcamp.com/track/...` URL in a track’s delivered HTML. This includes artist-customized SoundCloud banners—even when their button text is not “Download” or the banner is visually hidden. If no track release exists, it falls back to the first Bandcamp album release, while ignoring profile and unrelated Bandcamp links.

External link matching is strict: Bandcamp must be a single track or album release URL, while Hypeddit may contain one or two path segments. Malformed URLs with an appended serialized newline or extra path segment are ignored rather than shortened into a misleading destination.

Link matching is deliberately strict: Bandcamp URLs must be `https://artist.bandcamp.com/track/slug` or `/album/slug`, and Hypeddit URLs must be `https://hypeddit.com/artist/slug`. This prevents line-break remnants such as `/n/nDownload` from becoming part of a destination.

It can also scan a private playlist when you are already signed in to SoundCloud in the same Firefox profile and can open that playlist normally. It preserves SoundCloud secret URLs and uses your existing session only for those checks; it does not bypass private-access controls or share credentials.

## Load it in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `manifest.json` from this folder.
4. Because version 0.5.0 adds SoundCloud request observation, reload the SoundCloud playlist page once after loading or updating the extension. Wait until its first few tracks appear.
5. Click the extension toolbar button to open its persistent sidebar, then choose **Scan playlist**. No playlist scrolling is required, and the scan can continue while another tab or window is active.
6. On the first scan, approve Firefox’s optional request for Bandcamp access. SoundCloud access is a required extension permission so its initial metadata request can be observed before the Scan button is clicked.

Use **Copy report** to place the final list on the clipboard.

Open **Settings** in the sidebar to save the form details reserved for future gated-download flows and Bandcamp submissions, along with the preferred Bandcamp file type. The current Hypeddit final-button flow does not submit those gate details. The Browser tabs options store whether other supported tabs should be closed automatically and the timeout in milliseconds. The Connected accounts section checks the SoundCloud and Spotify accounts in the current Firefox profile and opens the relevant account or sign-in page in a new window. These values are saved in the extension's local browser storage.

The **LINK** column opens each discovered destination. The **DOWNLOAD** column supports uploader-enabled SoundCloud files, Hypeddit, and `Bandcamp (free)` entries. Hypeddit jobs are queued one at a time until Firefox creates each download; their muted background tabs and any child tabs are then closed while Firefox finishes the files. A Hypeddit failure closes its owned tabs and leaves a retryable pill. For Bandcamp album links, the report resolves the closest matching track title, selects the saved format for free downloads, and handles supported email delivery. Paid Bandcamp entries show a lock and open the official purchase page without automation.

If scanning fails, the popup opens a **Diagnostics** section. Use **Copy diagnostics** and share that output when reporting a problem. Secret query parameters and SoundCloud `/s-...` tokens are redacted from the diagnostic URL.

If diagnostics say the SoundCloud metadata request was not observed, reload the playlist tab once, wait for its first tracks to appear, and scan again. This is especially important for private playlists because their batch request uses the signed-in page's temporary authorization context.

The temporary signed-in request context is kept only in Firefox's in-memory extension session storage. It is removed when the source tab closes and is cleared when the browser session ends. It is never included in the extension diagnostics.

The page scanner is injected only when **Scan playlist** is clicked. The resulting track list is copied into a fixed snapshot, and all long-running track checks happen inside the persistent sidebar. Switching tabs or lazy-loading more playlist rows therefore does not retarget or mutate a scan already in progress.

## Notes

- SoundCloud’s page markup and internal web-app requests can change. Diagnostics report the embedded count, batch count, returned count, and whether a signed-in request context was captured.
- A playlist must be reloaded once after the extension is first installed or updated so the request observer can see SoundCloud's initial metadata request. Public playlists may also work from the page's visible request template without that reload.
- A track may show several pills—for example, an official SoundCloud download and a Bandcamp link—so you can choose the source you want to open.
