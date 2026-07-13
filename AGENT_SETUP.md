# Set up melchizedek with your coding agent

A copy-paste path from zero to a running agent syndicate, written for
the way people actually work now: your coding agent (Claude Code,
Cursor, Codex — any of them) does the machine steps, you do the human
steps, and the seams between the two are explicit.

Repo: https://github.com/jhwadman/melchizedek-agents
Course: https://lyceumagents.com/curriculum/
This file lives in both places and is identical in both.

---

## 1. The prompt — paste this to your coding agent

```text
Set up the melchizedek-agents framework on this machine.

1. Check prerequisites: `node --version` must be 22 or newer. If it
   isn't, stop and tell me before doing anything else.
2. Clone and install:
     git clone https://github.com/jhwadman/melchizedek-agents.git
     cd melchizedek-agents
     npm install
3. Create my env file: `cp .env.example .env`. Do NOT put any values in
   it. Never ask me to paste API keys into this chat, never read keys
   from elsewhere on my machine, and never commit .env.
4. Run the offline test suite (`npm test`) and confirm every shipped
   syndicate compiles.
5. Read README.md and QUICKSTART.md. Then report back with:
   - what you did and the test results,
   - the list of available syndicates (one line each, from the README
     table),
   - exactly which values I must fill into .env myself, what each one
     unlocks, and which are optional (the comments in .env.example
     say),
   - the exact command I should run for my first conversation.
Stop there. Do not start servers, do not configure Supabase, and do not
touch anything outside the cloned directory.
```

Why the guardrails in the prompt matter: keys belong in `.env`, entered
by your hands, never in a chat transcript — a pasted key lives in that
conversation's history forever. The stop-conditions keep the agent from
"helpfully" provisioning services you haven't decided to use yet.

## 2. Your steps — the parts that are yours on purpose

After the agent reports back:

1. **Get a Gemini API key** (free): https://aistudio.google.com →
   create key → open `.env` in your editor and set
   `GOOGLE_GENAI_API_KEY`. This one key runs every text syndicate.
2. **Optional — persistent memory** (free, needed for the two memory
   syndicates): create a project at https://supabase.com, copy the
   Project URL and `service_role` key into `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`, then paste the schema SQL from
   `DOCUMENTATION.md` §Sessions & long-term memory into the Supabase
   SQL Editor and run it — followed by `db/hardening.sql`, which locks
   the tables away from Supabase's public API. Do the SQL steps
   yourself, in the dashboard, so you know what your database holds.
3. **Optional — Claude models** (paid, usage-billed): set
   `ANTHROPIC_API_KEY` only if you want `claude-*` model ids in your
   syndicates. Nothing requires it.

## 3. First tests — meet the agents

```bash
npm run chat:syndicate        # default: Global Synthesis Council REPL
```

Ask it something that needs current information; watch the orchestrator
delegate to its research subagent. Type `exit` to end. Then try the
personalities:

```bash
npm run syndicate:critic      # drafter → critic confidence loop
npm run syndicate:delegation  # router → specialists
npm run syndicate:image       # spec-first image generation + blind audit
```

One-shot mode (answers and exits — this is also how you'll script it):

```bash
npm run syndicate:critic -- "In two sentences, why did the Library of Alexandria decline?"
```

If you configured Supabase, test the thing that makes this framework
worth keeping:

```bash
npm run syndicate:advocate    # long-term-memory patient advocate
# tell it a few facts, type exit — the session distills into records
npm run syndicate:advocate    # new session: it remembers
```

Correct a fact you told it in the second session, exit, and start a
third — the old record is superseded, not duplicated. That's the
structured memory pipeline working end to end.

## 4. Integration — putting a syndicate inside your app

The A2A server turns any syndicate into a JSON-RPC HTTP endpoint your
application calls like any other API:

1. Generate a server secret yourself: `openssl rand -hex 32` → set
   `A2A_SERVER_SECRET` in `.env`.
2. `npm run start:a2a` — the endpoint speaks the open A2A protocol,
   publishes an agent card, and enforces bearer auth + rate limiting.
3. Every request carries three headers: `Authorization: Bearer
   <A2A_SERVER_SECRET>`, `X-API-Key: <a Gemini key>` (inference bills
   the caller — your server key stays yours), and `X-User-Id: <your
   app's opaque user id>` — the id your backend assigns after
   authenticating its own user, never one the user chooses. That last
   header is what keeps one user's memory out of another's session.
4. `demo/a2a_demo.mjs` is a complete working client; `DOCUMENTATION.md`
   §A2A has the protocol details, and `lib/memory/README.md` covers
   per-user memory siloing and the right-to-erasure endpoint before you
   serve real people.

When you're ready, hand your coding agent a prompt shaped like this:

```text
My melchizedek-agents A2A server runs at <URL>. Read demo/a2a_demo.mjs
and DOCUMENTATION.md §A2A in the melchizedek-agents repo, then wire my
app's <feature> to it: send each authenticated user's message via
message/send with the three required headers, stream or poll the reply,
and render it in <where>. The bearer secret and Gemini key come from my
app's server-side environment — never expose either to the browser, and
never send a request without X-User-Id set to our internal account id.
Write the integration, then show me a test I can run against a scratch
user id.
```

Deploying the server itself (Heroku, Fly, a VPS) needs `PUBLIC_URL` set
— at which point the server refuses to start without the bearer secret,
by design. Run `db/hardening.sql` before real user data arrives, and
read the deployment notes in `lib/memory/README.md` end to end. The
patient in module 04's specimen would expect no less of you.
