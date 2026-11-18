# Swiftly

Swiftly is an experimental desktop browser built with Electron. It combines a
tabbed browser with a built-in, multi-provider search engine and local browsing
tools, with an emphasis on a clean interface and configurable privacy features.

## Features

- Search from the start page or address bar, with provider selection, region,
  Safe Search, suggestions, and configurable result counts.
- Browse with tabs, bookmarks, browsing history, downloads, session restore,
  and optional background-tab hibernation.
- Use Reader Mode to simplify articles, or Speed Reader for adjustable text
  size and a distraction-free reading view.
- Choose a light, dark, or system theme; manage zoom, spelling, and other
  browsing preferences in Settings.
- Configure the built-in Privacy Shield, Do Not Track, third-party cookie
  blocking, HTTPS-only mode, and clearing browsing data on exit.
- Open an incognito window with a separate in-memory browser session.
- Track focus minutes from the start page.

Swiftly is under active development; features and behavior may change.

## Run from source

### Requirements

- Node.js and npm
- A desktop environment supported by Electron

### Install and launch

```sh
git clone https://github.com/pendekarbau6-create/Swiftly-Public-Beta-.git
cd Swiftly-Public-Beta-
npm ci
npm start
```

For development, use `npm run dev`. To run the automated tests, use:

```sh
npm test
```

## Privacy and data

Swiftly keeps profile information, preferences, bookmarks, downloads, and
browsing history on the local computer. Profiles do not currently sync between
devices. Incognito windows use a separate in-memory session and are excluded
from saved browsing history.

Privacy settings provide useful protections but do not make browsing anonymous
or guarantee that every ad or tracker is blocked. Do Not Track is a request to
websites, not an enforcement mechanism. Searches and visits to websites send
network requests to the selected search providers and destination sites.

## Project layout

```text
src/
  main/       Electron main process, tabs, storage, and network controls
  pages/      Start page and internal browser pages
  preload/    Restricted APIs exposed to the UI
  renderer/   Browser chrome and tab interface
  search/     Search engine and provider integrations
test/         Automated tests
```

## Development commands

| Command | Description |
| --- | --- |
| `npm start` | Launch Swiftly |
| `npm run dev` | Launch Swiftly in development mode |
| `npm test` | Run the automated test suite |
