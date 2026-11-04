Plan the security requirement documents of project "{{project}}": together they must cover the whole application.

Additional instructions from the user (take precedence over everything else):
{{hint}}

Modules of the project (the matrix checks every requirement against each module they cover):
{{modules}}

Documents written by AI earlier (keep slug and key_prefix of a document you plan again; a document you leave out
stays as it is):
{{generated}}

Documents uploaded by humans (standards, guidelines; do not plan documents that only restate them — write what is
specific to this application):
{{uploaded}}

How to split:
- One document per security domain or coherent concern (e.g. "Authentication and sessions", "Authorization and tenant
  isolation", "Input handling and injection", "Data protection and secrets"), because each requirement is crossed with
  every module anyway. Give a component its own document only when it has a distinct security model (an admin console,
  a payment flow, a public API with other authentication).
- Typically 4–10 documents, each with 2–8 sections. A section is the group checked in one session per module: keep it
  focused on one concern, about 3–10 requirements.
- `modules`: the module names a document applies to; `[]` for cross-cutting documents (applies to all). Every module
  must be covered by at least one document. If there are no modules, use `[]`.
- `scope`: 2–4 sentences: what the document covers in this application — components, data, trust boundaries, entry
  points — so the writer and the reviewers know the boundaries and the documents do not overlap.
- `key_prefix`: short and unique (AUTHN, AUTHZ, INPUT, DATA, …).

Steps:
1. `whoami`, `list_modules`, and `get_entry_points` for the modules that have maps.
2. Survey the repository: build files, README/docs, security configuration (auth, CORS, TLS), data stores, outbound
   integrations, deployment files. Note which security domains apply and where.
3. Call `plan_security_documents` once with all documents and `set_name`, the name of the document set they form (fix
   and repeat if it reports an error).
4. Reply with the planned documents: title, modules, sections.
