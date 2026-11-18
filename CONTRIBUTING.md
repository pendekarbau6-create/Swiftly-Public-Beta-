# Contributing to Swiftly

Thanks for your interest in improving Swiftly. The browser and its independent
local search prototype are experimental, so small, focused contributions are
especially helpful.

## Development setup

1. Install Node.js 18 or newer and npm.
2. Clone the repository and install dependencies with `npm ci`.
3. Run the desktop app with `npm start`, or use `npm run search:web` to start
   the local search interface.
4. Run the test suite with `npm test`.

The local search crawler only visits the seed site's origin and honors
`robots.txt`. Crawl only sites you are permitted to access and index.

## Changes and pull requests

- Search existing issues before starting substantial work. For a large change,
  open an issue first to agree on scope.
- Keep pull requests focused and describe the user-visible change and the
  checks you ran.
- Add or update tests for behavior changes. For interface changes, include a
  screenshot when practical.
- Keep Electron access in the main/preload boundaries; do not expose Node.js
  APIs directly to page content.
- Do not commit credentials, personal browsing data, generated indexes, or
  local profile data.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

By submitting a contribution, you agree that it may be distributed under the
project's [MIT License](LICENSE).
