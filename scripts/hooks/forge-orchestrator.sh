#!/bin/sh

payload=$(cat)
if command -v jq >/dev/null 2>&1; then
  session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null || true)
else
  session_id=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi

marker_file=${HOME}/.forge/orchestrator-sessions
if [ -n "$session_id" ] && [ -f "$marker_file" ] && grep -F -x -e "$session_id" "$marker_file" >/dev/null 2>&1; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"This is a Forge task session. Before any other work, invoke the Skill tool with skill: orchestrator, announce the mode, then execute the seeded task brief."}}'
fi

exit 0
