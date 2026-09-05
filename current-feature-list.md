# SoundCloud Tracklist Download Helper — Feature List

## Purpose

Help a user process tracks from a supported SoundCloud collection, download files explicitly made available by the uploader, discover external download destinations, and keep a clear record of what happened.

The extension is a download **helper**, not a stream-ripping or download-gate-bypass tool.

## Inputs

### Supported collection links

The user can paste a SoundCloud URL or use the extension on the active SoundCloud page.

Planned supported sources:

- A SoundCloud playlist or set. (ex: https://soundcloud.com/catto_nip/sets/spice-v2)
- The signed-in user's Likes list. (ex: https://soundcloud.com/you/likes)
- A public user's Likes list, when the list is visible to the user. (ex: https://soundcloud.com/joncassss/likes)

When the active page is a supported collection, the extension can prefill the collection URL.

### Track range

The user can optionally limit a run with a start and end track.

- A blank start means the first track in the collected order.
- A blank end means the last track in the collected order.
- Blank start and end means every collected track.
- The implementation should identify range boundaries by the track name.
- use simple string matching to consider misspellings or typos (use 90% confidence)
- if no track found, resolve as "blank"

### Source options

The user can choose which legitimate source types to process or discover:

- **SoundCloud direct download** — use the uploader-enabled Download control, when present.
- **Hypeddit / Pumpyoursound link** — detect and report/open an external link.
- **Bandcamp link** — detect and report/open an external link; identify an apparent free or “name your price” option where possible.
- **Cloud-storage link** — detect Google Drive and Dropbox links and report/open them for the user.

### Hypeddit download handling

The extension uses its own background-tab runner. For a user-selected Hypeddit result, it clicks the final Download control already present in the page and waits for Firefox to create the resulting download. It does not load the legacy `tampermonkey_hypeddit_bypasser.js` file or automate social actions, comments, logins, email forms, or CAPTCHAs.

## Processing behavior

### Collection discovery

The extension collects tracks in the displayed collection order. It must account for lazy-loaded or long lists and tell the user when collection loading is incomplete.

Before a run begins, show a review screen containing the collection name, track count, selected range, and enabled sources.

### Download and link handling

- Start a direct SoundCloud download only when the uploader has made one available.
- For external sources, record the destination URL and open it only as the user has configured or confirmed.
- A Bandcamp free checkout may require user confirmation and may deliver a download link by email; it is not complete until a file has actually downloaded.
- Google Drive and Dropbox links are user-handled.
- Only tabs created by the extension may be auto-closed.

### Queue controls

The run screen should provide:

- Live progress per track.
- Pause, resume, and cancel controls.
- A conservative processing rate and a visible timeout.
- An option to auto-close extension-created tabs after a user-friendly timeout (seconds or minutes).

## Settings

### External-service form details

The user may save an email address, name, and optional comment for external sites that permit voluntary form completion. These values must remain local to the browser profile and be editable or removable.

The extension must not submit a third-party form without explicit user confirmation, and must not access the user's email inbox.

### Bandcamp preference

The user may express a preferred format:

- MP3 V0
- MP3 320
- FLAC
- AAC
- Ogg Vorbis
- ALAC
- WAV
- AIFF

This is used to pick which one to download from the bandcamp download page.

### Browser tabs

- Auto-close extension-created tabs: on/off.
- Auto-close delay: configurable in seconds or minutes.

## Outputs

### Files

Files downloaded through an authorized browser download are saved by Firefox according to the user's normal browser download preferences.

### Live and saved report

Show the report while the batch runs, then retain it as the last-run report (with room for future history/export).

Each row should include:

- Track title.
- Source found.
- Outcome.
- Saved filename, if a file completed.
- Relevant external link, if applicable.
- A short explanation and any required user action.

Use these outcomes rather than treating every discovered link as a success:

- Downloaded.
- Ready for user download.
- Checkout or email action required.
- No authorized download offered.
- Login, CAPTCHA, territory, or site restriction encountered.
- Timed out.
- Failed because the source changed or returned an error.

## Known limitations and edge cases

- SoundCloud collections may be private, unavailable in a territory, or loaded progressively.
- Track titles are not unique; use stable URLs or IDs for selection and reporting.
- Direct download availability, filenames, and formats are controlled by the source site.
- External sites can change their page structure or require user interaction at any time.
- A submitted Bandcamp checkout that sends an email is an action-required state, not a completed download.
- Do not infer a specific cause such as “not available in country” unless the site explicitly provides that information.
