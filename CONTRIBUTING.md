# Contributing to aiegis

Bug reports, feature requests, code, prompts, translations and documentation go through GitHub issues and pull requests.

## Issues

- Bug: steps, expected result, actual result, OS, aiegis version. Logs are described in [Data and logs](docs/data-and-logs.md); remove anything private before you attach them.
- Feature request: the problem first, then the proposed change.
- Vulnerability in aiegis itself: no public issue. Use **Report a vulnerability** on the repository's Security tab.

Open an issue before a large change to agree on the approach.

## Setting up

```bash
git clone https://github.com/seelentov/aiegis.git
cd aiegis
npm install
npm run setup      # rebuilds node-pty for Electron
npm start
```

## Before you open a pull request

```bash
npm run typecheck
npm test           # unit tests; they never call an AI agent
```

Both must pass. Changed behavior needs a new or updated test.

## Conventions

- No hardcoded values. Role prompts, permissions, models, effort, scanners and limits live in [`defaults/`](defaults) and reach the code through the configuration cascade. See [Configuration](docs/configuration.md).
- UI languages are English (default) and Russian. Every new UI string goes through `tr('English text')`, with its translation in `src/renderer/i18n-ru.ts`. Core messages, notifications and MCP replies are English only.
- Identifiers, comments and commit messages are in English.
- Follow the surrounding code: its structure, naming and comment density. Reuse an existing helper before adding one.
- A change in what users see or do updates the matching page in [`docs/`](docs).
- One topic per pull request. Commit subject format is `Area: what changed`, for example `Signals: import SARIF 2.1.0 reports`.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
