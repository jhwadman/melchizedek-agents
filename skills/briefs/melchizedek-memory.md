AUDIENCE: a coding agent working for a software engineer who wants an agent to remember across runs, or is debugging why it does not.
KIND: a SKILL.md skill file.
PURPOSE: after reading it the agent can set the memory mode in a syndicate, provision Supabase for it, add the memory tools, write extraction rules, prove memory works, inspect and erase what was stored, and diagnose the two common failures.

STRUCTURE (exact):
Frontmatter, verbatim:
---
name: melchizedek-memory
description: Give a Melchizedek syndicate persistent sessions and long-term memory on Supabase: the memory_system modes, the two tables and the match function, the memory tools, extraction rules, inspection and erasure. Use when the user wants an agent to remember across runs, sets up Supabase for melchizedek, or asks why recall returns nothing.
---
Then `##` sections in this order: "The three memory modes", "Provision Supabase", "What gets stored", "Wire the syndicate", "Prove it", "Inspect and erase", "When recall returns nothing".

FACTS:
The three memory modes (`memory_system:` in the YAML):
- `internal-only`: the default; nothing persists past the process.
- `session-only`: the running transcript (events and state) persists in the `adk_sessions` table, so a conversation survives a restart.
- `long-term`: sessions persist, and at session end the transcript is distilled into structured memory facts in `adk_memory_facts`, embedded, and recalled in later sessions.
- Without Supabase credentials, both persistent modes fall back to in-memory sessions and the startup banner says so. Long-term memory also needs GOOGLE_GENAI_API_KEY, because embeddings and fact extraction run on Gemini.
Provision Supabase:
- Create a project at supabase.com; put the Project URL and the service_role key in `.env` as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Run the SQL from `DOCUMENTATION.md` section 4 (the package ships this file; in a clone it is at the repository root) in the Supabase SQL Editor: it enables pgvector, creates `adk_sessions` and `adk_memory_facts` (a 768-dimension embedding beside `tag`, `fact_date`, `source`, `status`, `keys`, `superseded_by`), the indexes, and the similarity function `match_memory_facts`.
- Upgrading an older install: `db/memory_v2.sql` in a clone is the upgrade path.
- Harden it: run `db/hardening.sql` in the same editor; it enables deny-by-default row-level security so the anon key cannot read the session or memory tables over the REST API.
What gets stored:
- Each record is one line: `[TAG | date: YYYY-MM-DD | source: <who asserted it> | status: active|historical | keys: k1, k2] record text`. Tags: FACT, PREFERENCE, DECISION, ACTION, CONTEXT, INSIGHT, CORRECTION, EPISODE (one narrative summary per session).
- The date is the date the record is about, made absolute at write time; the source is who asserted it (the model's own knowledge is never stored); values keep their units as stated; a correction supersedes the row it corrects (kept as history, status `superseded`); an unresolved contradiction stores both records plus a CONTEXT record naming the conflict.
- Recall is cosine similarity re-ranked by entity keys and dates. Records are siloed per syndicate and user (`user_key`) and can be erased.
- Ingestion runs on `exit`, on Ctrl-C, after a one-shot run, and on the A2A server after every task.
Wire the syndicate:
- Set `memory_system: "long-term"`.
- Give the orchestrator the tools by name: `preload_memory` loads what is known about the user at the start of a session; `load_memory` recalls facts mid-conversation as the topic turns. `patient_advocate.yaml` shows both, with an instruction that sets what is said aloud and what is only recorded.
- `memory_extraction_rules:` (top level, optional): domain rules appended to the shared extraction prompt for this syndicate only, in the form of NEVER store / ALWAYS store lines, such as never storing a value that goes stale on its own and always storing what the user asserted, decided, or committed to.
Prove it:
- `npx melchizedek-chat --syndicate ares -- "Remember: my project is called athens-prod."` then `npx melchizedek-chat --syndicate ares -- "What do you know about my project?"` (clone: `npm run syndicate:ares -- "..."`). The second run recalls the first.
Inspect and erase (clone commands; the scripts are not package executables):
- `npm run memory -- list` shows every silo with counts; `npm run memory -- list --silo <key>` the records in one silo; `--dupes` groups likely restatements.
- `npm run memory -- delete --silo <key> <id>` is a dry run that prints what would go; add `--yes` to delete; `--all --yes` erases one silo. Ids may be the 8-character prefix shown by list.
- `npm run db:purge` wipes all sessions and memory facts.
- As a dependency, the service class `SupabaseVectorMemoryService` is importable from `melchizedek-agents/memory` for code that needs the same store.
When recall returns nothing:
- The tables exist but `match_memory_facts` was never created (rerun the SQL), or the query runs under a different `user_key` than the one that stored the facts.
- Sessions do not persist between runs: `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing and the framework fell back to in-memory sessions.

IDENTIFIERS (verbatim): memory_system:, internal-only, session-only, long-term, adk_sessions, adk_memory_facts, match_memory_facts, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_GENAI_API_KEY, DOCUMENTATION.md, db/memory_v2.sql, db/hardening.sql, preload_memory, load_memory, memory_extraction_rules:, user_key, patient_advocate.yaml, npx melchizedek-chat --syndicate ares, npm run memory -- list, --silo, --dupes, --yes, npm run db:purge, SupabaseVectorMemoryService, melchizedek-agents/memory
LIMITS: the record format line goes in a fenced block. Body under 160 lines.
