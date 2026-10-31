Write the security requirement document "{{title}}" (slug `{{slug}}`, requirement ids `{{key_prefix}}-<n>`) of
project "{{project}}".

Additional instructions from the user (take precedence over everything else):
{{hint}}

Scope of this document:
{{scope}}

It applies to {{modules}}

Sections (use them as `##` headings in this order; rename or add one only if the code requires it):
{{sections}}

Other documents of the plan (do not write their requirements here):
{{other_documents}}

Approved requirements of the current version of this document (may be empty). A requirement that is still right
must be copied exactly, with its id and wording — unchanged text keeps its review and check history. Reword only what
is wrong for the code now; drop what no longer applies. New requirements get numbers above the highest one used;
never reuse the number of a dropped requirement.
{{previous}}

Steps:
1. Study the code in scope: entry points (`get_entry_points`), the security configuration, the data and flows the
   scope names. Note concrete components, files and data for each section.
2. Write the document in Markdown, exactly in this form:

   ```
   # {{title}}

   <Scope: 3–6 sentences on what this document protects in this application — components, data, trust boundaries.>

   ## <Section>

   - **{{key_prefix}}-1** <One requirement sentence: the subject must / must not …>
     Applies to: <components or paths>. Why: <the threat it prevents>.
   ```

   - Each requirement is one list item on a single line starting with `- **{{key_prefix}}-<n>**`; the indented line
     under it is context for humans and is not part of the requirement.
   - Only requirements are list items with bold ids; do not number anything else that way.
3. Call `save_security_document` with slug `{{slug}}` and the whole text. If it reports an error, fix and call again.
4. Reply with the number of requirements per section.
