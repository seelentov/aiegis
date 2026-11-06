# Modules

A module is a name, a set of globs and a description. The globs are the source of truth: they decide which files belong to the module. Every check that works per module (entry point maps, matrix verdicts, SCA) uses them.

![The Modules tab](screenshots/modules.png)

## Globs

Globs are git pathspec globs, relative to the repository root:

- `*` does not cross `/`, `**` does;
- a leading `!` excludes;
- at least one including glob is required.

A module's files are the tracked files (`git ls-files`) that match. **Check globs** shows the count and a sample before you save. Globs that match no file are refused.

## Creating and changing modules

- **Module** adds one by hand.
- **Mark up**, under **AI module markup**, runs the agent (role `modules`). The optional hints say which parts of the repository to mark up and how to name them. A new markup does not erase your edits: each change is a new revision.
- In the details panel you can edit a module, or delete it with a required reason.

Revisions are append-only. The details panel shows the history with the author (`human` or `ai:modules`) and the run. Saving without changes creates no revision, and names are unique among live modules.

A module's agent, model, instructions and permissions can be overridden in the project configuration under `modules.<name>`, matched by name. See the [cascade](configuration.md#the-cascade).

## Module columns and details

The table shows each module's name, globs, description and entry point map, including whether the map is `stale`. The details panel adds:

- the globs and the number of files;
- the revision history;
- the effective configuration of the map, including the module level;
- **Build map** or **Rebuild map**, **Open map**, and **Watch output** while a job runs.

**Map all** queues a map for every module.

## Command line

```bash
aiegis module list
aiegis module preview 'api/**' '!api/test/**'
aiegis module save api --glob 'api/**' --glob 'lib/**' --description 'Public API'
aiegis module parse --hint 'Two modules: api and admin'
aiegis module history <module>
aiegis module remove <module> 'Merged into api'
```

See the [CLI reference](cli.md#module).
