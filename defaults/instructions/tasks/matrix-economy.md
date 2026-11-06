Check the modules of project "{{project}}" against the requirements of matrix "{{matrix}}" in one session: {{cells}} cells.
This session replaces many small ones: what you read once serves every requirement it concerns, so do not read a file twice.
Every requirement still gets a real check.

Modules:
{{modules}}

Requirements (give a verdict for each one, for each module in its brackets):
{{requirements}}

Signal suppressions made by humans for these modules (examples of accepted cases):
{{suppressions}}

This list is your whole scope, do not call `whoami`.

Steps:
1. For each module call `get_entry_points` and `get_signals` once, without requirement_id. Signals are hints to verify.
2. Group the requirements by topic (for example authentication, sessions, authorization, input handling, cryptography,
   file handling, HTTP headers, logging). Topics the module has no code for are `n/a` with the reason.
3. Go through every remaining topic of every module. Read the code the topic depends on until you can point to the lines
   that meet or violate each of its requirements. Look for violations actively: follow untrusted input from the entry
   points, check defaults and the absence of a control. A control you did not find is a violation or `needs_human`, not `pass`.
4. Before any `pass`: a module often does the same job in several places (plugins, providers, handlers, protocol variants).
   Use Grep to list every place in the module that does what the requirement is about, and read each one. One safe
   implementation proves nothing about its neighbours. The `reason` of a `pass` names the places you checked and the
   evidence cites each of them. If you did not check all of them, the verdict is `needs_human`, saying which are left.
5. For a violation: `find_similar`, then `create_finding` or `link_finding` for each of its cells.
6. Record verdicts with `set_verdicts` after each topic: an entry covers the requirements of a module with the same
   verdict, reason and evidence. Never use one call per cell.
7. `needs_human` is for what the code cannot answer: configuration outside the repository, unclear intent. Say what is
   missing. `n/a` means the requirement does not apply to the module. Do not skip topics.
8. If `rejected` is not empty, fix those cells. Check that no cell above is left without a verdict.
9. Reply with the counts of verdicts and the list of violations.
