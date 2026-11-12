# Agents: Claude Code or pi

aiegis starts a local coding agent for every session. The cascade field `agent` chooses which:

- `claude` (default): local [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), with a subscription or an API key. Settings are under `claude:`.
- `pi`: the [pi coding agent](https://pi.dev), the same engine as [JetBrains ThinkRail](https://github.com/JetBrains/thinkrail). It works with models of any provider pi knows, such as Anthropic, OpenAI, Google, or local models through `models.json`. Credentials are pi's own (`pi` → `/login`, or the provider's environment variables). Settings are under `pi:`.

The field works at every cascade level, so you can change the agent for the whole app, a project, a role or a module:

```yaml
# ~/.aiegis/config.yaml: everything through pi
agent: pi

# <repo>/.aiegis/config.yaml: only the cheap stages through pi with an OpenAI model
# (model ids come from `pi --list-models`, which shows providers you have credentials for)
roles:
  matrix-triage: { agent: pi, model: openai/gpt-5-mini, effort: low }
  sca: { agent: pi, model: openai/gpt-5-mini }
```

## How each agent runs

| | Claude Code | pi |
|---|---|---|
| Background run | `claude -p --output-format stream-json --session-id …` | `pi --mode json --session-id …` |
| Continue a session | `claude --resume <id>` | `pi --session-id <id>` |
| Model, effort | `--model`, `--effort` | `--model`, `--thinking` |
| Role instructions | `--append-system-prompt` | `--append-system-prompt` |
| aiegis MCP server | `--mcp-config` (a file with the token) | The aiegis extension registers it with the run's token |
| `permissions` | `--allowedTools`, `--disallowedTools` | The aiegis extension checks every tool call |
| Isolation of background runs | `claude.background_args` | `pi.background_args`: no user extensions, skills, templates or project settings |
| PoC tester sandbox | `poc.claude_settings` → `--settings` | `poc.pi_sandbox` → the aiegis extension (`@anthropic-ai/sandbox-runtime`) |

Prompts go through stdin. A run's outcome, tokens and cost come from the agent's output stream. pi exits with 0 even when a model fails, so its outcome is read from the last assistant message. Prompts of roles do not change between agents, since MCP tool names are the same (`mcp__aiegis__*`).

## Permissions under pi

pi has no permission system of its own, so an aiegis extension loads with every session. It reads the role's rules, written in Claude Code syntax:

- Tools are mapped through `pi.tools`: `Read → read`, `Grep → grep`, `Glob → find, ls`, `Bash → bash`, `Edit → edit`, `Write → write`. `WebFetch` and `NotebookEdit` have no counterpart.
- `deny` wins, including for any part of a compound command.
- `Bash(git log:*)` allows commands with that prefix, at a word boundary. With pattern rules only a simple command passes: no `$(…)`, backticks or redirection, and each part of `&&`, `||`, `;`, `|`, `&` outside quotes must be allowed.
- `Edit(./.aiegis-sca/**)` and similar rules are globs over the absolute path (also `~/…` and `//abs`).
- Tools with a path do not leave the working directory and `permissions.dirs`, and for env-setup also your checkout. Paths are checked after resolving symbolic links, so a link committed in the repository cannot lead a tool to a file outside these directories.
- Anything the rules do not allow is blocked in background runs, and asked of you in interactive sessions.

## PoC tester under pi

See [PoC tester](poc.md#isolation). Each `bash` command first goes through the same aiegis hook, then runs in the OS sandbox with the network limited to the `host:port` of `base_url` and writes limited to the working directory. If the sandbox is unavailable (Windows, no bubblewrap on Linux) or the hook does not respond, commands are blocked. A command you type yourself with `!` in an interactive session is not wrapped.

## Limitations of pi

- Provider rate limits are recognized from the error text. The reset time is unknown, so the queue pauses for `queue.rate_limit_fallback_pause_sec`.
- A session continues only with the agent that created it. If you change `agent` after a run, **Open session** says so.
- pi has no equivalent of `--strict-mcp-config`: servers in your `~/.pi/agent/mcp.json` connect, but background sessions declare only `mcp__aiegis__*` to the model.
- Extensions that replace pi's built-in MCP, such as `pi-mcp-adapter`, may disable the aiegis server in interactive sessions.
- A Claude subscription may be refused in pi, in which case you need an API key or another provider.
