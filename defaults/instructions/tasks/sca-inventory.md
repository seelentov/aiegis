Build the dependency inventory of module "{{module_name}}" (module_id `{{module_id}}`) in project "{{project}}".

Module description: {{module_description}}

Module files are the tracked files matching these globs (relative to the repository root):
{{module_globs}}

Your run directory (relative to the current directory, already created): `{{out_dir}}`
Write every file you create (init scripts, tool reports) there.

Files with dependency data uploaded by humans for this module (use them if they fit; they are in the run directory):
{{inputs}}

Dependency vulnerabilities that configured scanners already reported for the module's paths (hints, may be incomplete
or based on declared rather than resolved versions):
{{scanner_hints}}

Steps:
1. Find how the module is built and which manifests declare its dependencies (build files of the module and of the
   repository root: Gradle, Maven, npm/yarn/pnpm, pip/poetry, Go, Cargo...).
2. Get the resolved dependency list of the module's runtime, transitive dependencies included. Use lock files when they
   exist; otherwise ask the build tool. Example for Gradle without lock files: write an init script
   `{{out_dir}}/lock.init.gradle` with `allprojects { dependencyLocking { lockAllConfigurations() } }` and run
   `./gradlew --offline -q -I {{out_dir}}/lock.init.gradle :<gradle project>:dependencies --configuration runtimeClasspath --write-locks`;
   it writes `gradle.lockfile` next to the module's build file.
3. Look up vulnerabilities of the resolved dependencies with an available scanner and save its JSON report into the
   run directory (for example `trivy fs --scanners vuln --format json --output {{out_dir}}/trivy.json <module dir>`).
4. For every vulnerable package@version call `add_vulnerable_package` with module_id `{{module_id}}`, the report path,
   ecosystem, name, version, whether the module declares it directly, the manifest that brings it in, and
   `import_names` — how code refers to the package: for Java the top-level packages of its classes (list the jar, e.g.
   `unzip -l` on the jar from `~/.gradle/caches/modules-2` or `~/.m2/repository`), for npm the package name, for
   Python the importable module names. aiegis uses `import_names` to skip packages the module never refers to
   (without them every package costs an AI session), so collect them for every vulnerable package — in one batched
   command for all packages rather than one call per package — and leave them empty only where the tool output
   gives nothing; never guess.
5. Call `set_inventory_summary` with the ecosystems, the tools you used, the number of resolved dependencies you checked
   and the manifests (build/lock files) the result depends on.
6. Reply with a short summary: tools, number of dependencies, vulnerable packages, anything you could not resolve.
