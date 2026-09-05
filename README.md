# SOUNDCLOUD BATCH DOWNLOADER

A Firefox sidebar extension that scans the tracklist of a SoundCloud playlist and reveals download links where possible:

- `Soundcloud` - on tracks with downloads enabled
- `Hypeddit` - on tracks where a matching link is found in the description
- `Bandcamp` - on Bandcamp links, with support for album and free/paid/email needed downloads

## USAGE

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `manifest.json` from this folder.
4. Click the extension toolbar button to open its persistent sidebar, then choose **Scan playlist**. No playlist scrolling is required, and the scan can continue while another tab or window is active.

- `Settings` - contains details used to autofill form data
- `TITLE` - hyperlinks to the SoundCloud track page
- `LINK` - hyperlinks to the discovered download page
- `DOWNLOAD` - buttons that autofill forms and initiate downloads straight from the extension

## TODO

- Add support for more gates
	- hypeddit alternate (https://soundcloud.com/litkvt/charli-xcx-1999-kat-remix-2)
	- linksr.io (https://soundcloud.com/jaxonwild/choparezz)
	- valorizd.app (https://soundcloud.com/ader2k/overseas-x-jeans-ader2k)
	- toneden.io (https://soundcloud.com/ornomusic/realspring)
	- ffm.to (https://soundcloud.com/nightmoderecs/cani)
	- lnk.to (https://soundcloud.com/elmyxmusic/revesaparremix)
	- Dropbox & Google Drive (https://soundcloud.com/xxena_00/elysian-hardcore)
- Fix region locked tracks appearing only as unavailable and not region locked
- Add batch auto download
- Add start/end scan playlist markers
- Fix on "Finished" pill hover, stuck at loading cursor
- Fix latest playlist scan not being saved on extension close
- Add manual "Downloaded" tickbox to mark existing tracks on disk
- Add import/export playlist scan with download status
- Add hierarchy for tracks with multiple links
- Fix various bugs that occur when re-running the extension on other playlists