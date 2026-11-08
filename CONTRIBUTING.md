# Contributing to aiegis

Thank you for helping. Bug reports, ideas, code, prompts, translations and documentation are all welcome.

## Issues

- **Bugs:** what you did, what you expected, what happened, your OS and the aiegis version. Logs are described in [Data and logs](docs/data-and-logs.md); remove anything private before you attach them.
- **Ideas:** describe the problem first, then the change you have in mind.
- **Security vulnerabilities in aiegis itself:** do not open a public issue. Use **Report a vulnerability** on the repository's Security tab.

For a large change, open an issue first so we can agree on the approach before you write the code.

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

Both must pass. Add or update tests for the behavior you change.

## Conventions

- **Nothing hardcoded.** Role prompts, permissions, models, effort, scanners and limits live in [`defaults/`](defaults) and reach the code through the configuration cascade. See [Configuration](docs/configuration.md).
- **Two UI languages.** English is the default, Russian is the second one. Every new UI text goes through `tr('English text')`, with its translation in `src/renderer/i18n-ru.ts`. Messages of the core, notifications and MCP replies are English only.
- **English in code.** Identifiers, comments and commit messages are in English.
- **Match the surrounding code.** Keep the existing structure, naming and comment density; prefer reusing a helper over adding a new one.
- **Documentation.** If you change what a user sees or does, update the matching page in [`docs/`](docs).
- **Commits.** One topic per pull request. Commit subjects are short and say what changed, for example `Signals: import SARIF 2.1.0 reports`.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
