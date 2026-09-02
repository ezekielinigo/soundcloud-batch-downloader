# SoundCloud Tracklist Download Helper — MVP

## Goal

Process one user-selected SoundCloud playlist or the currently open supported collection, download uploader-enabled SoundCloud files, and give the user a reliable report of every result.

## In scope

### Input

- Paste a SoundCloud playlist URL.
- Autofill the URL when the user opens the extension on a supported playlist page.
- Load tracks in collection order.
- Optional start and end boundaries, selected by track URL/ID rather than title alone.

### Download behavior

- Detect whether each track offers SoundCloud’s own direct download.
- Download only files that SoundCloud exposes through that uploader-enabled control.
- Process a small, sequential queue.
- Allow the user to cancel the run.

### Report

Display live progress and a final report with:

- Track title and SoundCloud URL.
- Position in the playlist.
- Outcome: **Downloaded**, **No authorized download offered**, **Timed out**, or **Failed**.
- Final filename when the browser completes a download.

## Deferred to later releases

- Likes lists and public-profile Likes.
- Detection of Bandcamp, Hypeddit, Pumpyoursound, Google Drive, and Dropbox links.
- External-site tabs, auto-close behavior, form preferences, and Bandcamp format preferences.
- Pause/resume, retry policy, run history, and report export.
- Support for long lazy-loaded collections and advanced progress recovery.

## Not included

- Stream ripping, conversion, or “force download” fallbacks.
- Download-wall, CAPTCHA, social-gate, payment, or access-restriction bypasses.
- Automated third-party checkout or email inbox access.

## MVP acceptance criteria

1. On a supported playlist page, the extension identifies the playlist and its tracks.
2. The user can select all tracks or a defined range.
3. The extension attempts only uploader-enabled SoundCloud downloads.
4. The report accurately distinguishes completed downloads from tracks with no authorized download.
5. Cancelling stops new items from being started and preserves completed results in the report.
