# Getting started

## Requirements

- `git`.
- A coding agent, installed and logged in:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) (`claude` on `PATH`), the default; or
  - [pi](https://pi.dev) (`npm install -g @earendil-works/pi-coding-agent`, `pi` on `PATH`, a provider configured in pi itself) with `agent: pi` in `~/.aiegis/config.yaml`. See [Agents](agents.md).
- Optional scanners on `PATH`: `semgrep`, `gitleaks`, `trivy` (on macOS: `brew install semgrep gitleaks trivy`). A scanner that is missing is skipped with a warning.
- Optional: VS Code, for opening `file:line` references in your editor.

The app takes your `PATH` from your login shell at startup, so tools you can run in a terminal are also found when the app starts from Finder or the Dock.

## Install

Download a build from the [releases page](https://github.com/seelentov/aiegis/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `aiegis-<version>-mac-arm64.dmg` or `.zip` |
| Windows x64 | `aiegis-<version>-win-x64.exe` |
| Linux x64 | `aiegis-<version>-linux-x86_64.AppImage` or `-linux-amd64.deb` |
| Linux x64, arm64: [service without a window](service.md) | `aiegis-<version>-linux-x64`, `aiegis-<version>-linux-arm64` |

Builds are not signed. On macOS, right-click the app and choose **Open** the first time, or run `xattr -dr com.apple.quarantine /Applications/aiegis.app`.

To run from source:

```bash
git clone https://github.com/seelentov/aiegis.git
cd aiegis
npm install
npm run setup      # rebuilds node-pty for Electron
npm start
```

macOS is the main platform. Windows and Linux builds are produced automatically and get less testing.

## First start

1. Start aiegis.
2. The [setup guide](interface.md#setup-guide) opens. Click **Add project** and choose the root of a git repository. The guide then shows each step below with its state and next action, and it opens again for every project you add later.
3. The default settings are copied to `~/.aiegis/` (`config.yaml` and the prompts of roles and tasks). You can edit them on the **Settings** tab. See [Configuration](configuration.md).

The interface is in English by default. To switch to Russian, set `ui.language: ru` in **Settings → Global → Interface**. The window reloads after you save.

## A first audit

The steps below are the usual order; the setup guide follows the same path. Each one links to its full description.

1. **Choose cheap models while you try it.** Create `<repo>/.aiegis/config.yaml`:

   ```yaml
   roles:
     modules: { model: haiku, effort: low }
     requirements: { model: haiku, effort: low }
     matrix-triage: { model: haiku, effort: low }
     matrix: { model: sonnet, effort: low }
   limits:
     max_tokens_per_run: 150000
   ```

2. **Split the repository into [modules](modules.md).** On **Modules**, click **Mark up** to let the agent do it, or add modules by hand.
3. **Build [entry point maps](entry-points.md).** Click **Map all** on **Modules**. One session runs per module.
4. **Add a [document](documents.md).** On **Documents**, upload a standard or an internal guideline (MD, PDF, DOCX). The agent extracts requirements with quotes, and you review and approve them. If you have no document yet, **Write documents** under **Write security documents with AI** lets the agent write one from your code.
5. **Build the [matrix](matrix.md).** Create a matrix from the approved documents and modules, then run **n/a triage** and **Verdicts**. Each run shows an estimate of sessions and tokens first.
6. **Work through the [findings](findings.md).** Confirm them, reject false positives, accept risks, or open a fix session. The [PoC tester](poc.md) can try to reproduce a finding against a test instance.
7. **Check [dependencies](sca.md) and [scanner signals](signals.md).** Run the dependency inventory and the reachability check, then suppress noise with a stated reason.
8. **Keep it current.** After new commits, verdicts whose evidence changed are marked `stale`, so you recheck only those. [Branch checks](branch-check.md) review a branch before it merges, [the document refresher](document-refresher.md) notices new editions of your documents, and [schedules](schedules.md) run all of this on cron.

## Next

- [Concepts](concepts.md) explains roles, runs, worktrees and the cascade.
- [Interface](interface.md) covers the layout and keyboard shortcuts.
- [Security](security.md) describes what agents can and cannot do.
