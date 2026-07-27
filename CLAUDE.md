@AGENTS.md

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain has this repo's code indexed on this machine. Prefer `gbrain` over
Grep when you don't know the exact identifier yet.

**This worktree is pinned** via the `.gbrain-source` file in the repo root;
`gbrain` commands run from anywhere under this worktree route to the
`gstack-code-forge` source automatically.

Prefer gbrain when:
- "Where is X handled?" and you have distinctive terms:
    `gbrain search "<terms>"`
- "Where is symbol Y defined?" / "what references Y?":
    `gbrain code-def <symbol>` / `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. Run `/sync-gbrain` after meaningful code changes land.

Limits on this machine (by design):
- gbrain is code-search only here. Decisions, session memory, and project
  context live in jarvis-memory — never store or query them through gbrain.

<!-- gstack-gbrain-search-guidance:end -->
