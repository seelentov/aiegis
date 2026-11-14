# Agents: Claude Code or pi

Every session runs a local coding agent selected by the cascade field `agent`:

- `claude` (default): local [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), with a subscription or an API key. Settings are under `claude:`.
- `pi`: the [pi coding agent](https://pi.dev), the engine behind [JetBrains ThinkRail](https://github.com/JetBrains/thinkrail). Supports any provider pi knows (Anthropic, OpenAI, Google, local models through `models.json`). Credentials are pi's own (`pi` → `/login`, or the provider's environment variables). Settings are under `pi:`.

`agent` is valid at every cascade level: app, project, role, module.

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

Prompts go through stdin. Outcome, tokens and cost are parsed from the agent's output stream. pi exits with 0 even when the model call fails, so its outcome comes from the last assistant message. Role prompts are the same for both agents because MCP tool names match (`mcp__aiegis__*`).

## Permissions under pi

pi has no permission system, so an aiegis extension loads into every pi session and enforces the role's rules, written in Claude Code syntax:

- Tools are mapped through `pi.tools`: `Read → read`, `Grep → grep`, `Glob → find, ls`, `Bash → bash`, `Edit → edit`, `Write → write`. `WebFetch` and `NotebookEdit` have no counterpart.
- `deny` wins, including for any part of a compound command.
- `Bash(git log:*)` allows commands with that prefix, at a word boundary. With pattern rules only a simple command passes: no `$(…)`, backticks or redirection, and each part of `&&`, `||`, `;`, `|`, `&` outside quotes must be allowed.
- `Edit(./.aiegis-sca/**)` and similar rules are globs over the absolute path (also `~/…` and `//abs`).
- Path tools are confined to the working directory and `permissions.dirs` (for env-setup also your checkout). Paths are checked after symlink resolution, so a committed symlink can't point a tool outside these directories.
- Calls the rules don't allow are blocked in background runs and prompt the user in interactive sessions.

## PoC tester under pi

See [PoC tester](poc.md#isolation). Each `bash` command passes the aiegis hook, then runs in the OS sandbox with network limited to the `host:port` of `base_url` and writes limited to the working directory. If the sandbox is unavailable (Windows, Linux without bubblewrap) or the hook doesn't respond, commands are blocked. Commands typed by the user with `!` in an interactive session aren't wrapped.

## Limitations of pi

- Rate limits are detected from the error text. pi gives no reset time, so the queue pauses for `queue.rate_limit_fallback_pause_sec`.
- A session can only be continued by the agent that created it; after changing `agent`, **Open session** reports the mismatch.
- pi has no `--strict-mcp-config`: servers from `~/.pi/agent/mcp.json` connect too, though background sessions expose only `mcp__aiegis__*` tools to the model.
- Extensions that replace pi's built-in MCP, such as `pi-mcp-adapter`, can disable the aiegis server in interactive sessions.
- pi may reject a Claude subscription; use an API key or another provider then.
