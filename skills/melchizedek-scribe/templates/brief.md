AUDIENCE: <who reads the document and what they already know>

KIND: <skill file | README section | page copy | runbook | changelog entry | email>

PURPOSE: <what the reader can do after reading it>

STRUCTURE: <required headings in order; for a SKILL.md, the exact frontmatter block:
---
name: <directory-name, lowercase, hyphens>
description: <when to use this skill, under 1024 characters>
---
>

FACTS:
- <one statement per line; this list is the Scribe's whole knowledge>
- <put every command here with its exact flags>
- <mark anything planned or not shipped as such>

IDENTIFIERS (verbatim): <commands, flags, paths, env vars, package names, model ids, URLs — comma separated>

LIMITS:
- <line or word cap>
- <every command in a fenced bash block>
- <constructions to avoid, if any beyond the standard>

SOURCE MATERIAL (optional):
<pasted text the Scribe may quote or draw facts from>
