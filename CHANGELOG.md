# Changelog

The section for a version is what DJs see in the in-app update alert and on the
GitHub Release, so write it for DJs, not developers. The release workflow
refuses to publish a tag that has no matching section here.

Format: `## [X.Y.Z] - YYYY-MM-DD`, newest first. Before tagging, rename
`[Unreleased]` to the new version (see RELEASE.md).

## [Unreleased]

- Decks Bridge now tells you when a new version is available, shows what's new,
  and installs it for you. Choose "Update Now" or "Remind Me Later".
- Mac downloads are now signed by the developer and notarized by Apple, so macOS
  opens them without a security warning. If you used a test build before, macOS
  may ask you once to allow Accessibility or Automation again.
- Auto-detect now stays on after you restart Decks Bridge (it used to switch
  back to Manual).
- On a Mac, closing the window no longer quits: Decks Bridge keeps syncing in
  the background. Click its Dock icon to bring the window back; quit with ⌘Q.
- Tracks played while you're offline are no longer lost if the connection drops
  while they are being sent.
- `decksbridge://` pairing links now fill in the code and wait for you to press
  Connect, instead of connecting on their own.
- Your pairing is kept when you update, so there's no need to pair again.
- Pairing codes and tokens are no longer written to the log files you might
  send to support.
- Uses less CPU while detecting what's playing.

## [0.1.0] - 2026-05-19

- Initial release.
