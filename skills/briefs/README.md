# Briefs

One brief per document in the suite. `_shared.md` is prepended to every
skill brief (its SHARED FACTS half to `skills-readme.md`, the brief for
`skills/README.md`). A skill is regenerated from its brief with the Scribe
and reviewed by a person; the prose is never patched with the brief left
stale:

```bash
cat skills/briefs/_shared.md skills/briefs/melchizedek-models.md > /tmp/brief.md
CHAT_STREAMING=false npm run syndicate:scribe -- "$(cat /tmp/brief.md)" > /tmp/scribe.out
# the document is everything after the last "Scribe › " line
```

Written 2026-09-24; the Scribe was `config/agents/examples/scribe.yaml` on
`gemini-3.8-flash`.
