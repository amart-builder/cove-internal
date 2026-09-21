# shellcheck shell=bash
#
# One shared answer to "is a Cove serving right now?".
#
# launchctl only knows the services the installer loaded. Setup Step 4 starts
# the web app by hand, and so does anyone who stopped the services to watch a
# log, so "no service is loaded" is not the same question as "nothing is
# running" -- and the difference is a restore that goes over a live writer, or a
# status line that tells someone Cove is not installed while it serves their
# day. Every caller that means the second question asks here.
#
# Only an installed Cove has recorded where it serves: the installer writes
# COVE_BRIEF_WEB_BASE into .env.local. A checkout that was never installed has
# not, and falling back to the documented default would make these scripts
# depend on whatever else answers on that port -- including during the test
# suite. So an unrecorded address means "not serving", never a guess.
#
# Callers set COVE_SERVING_REPO_DIR and COVE_SERVING_NODE before sourcing.

COVE_WEB_PORT=""

cove_web_base_configured() {
  [ -n "${COVE_BRIEF_WEB_BASE:-}" ] && return 0
  [ -f "${COVE_SERVING_REPO_DIR:-}/.env.local" ] &&
    grep -qE '^[[:space:]]*COVE_BRIEF_WEB_BASE[[:space:]]*=' "$COVE_SERVING_REPO_DIR/.env.local"
}

# Sets COVE_WEB_PORT as a side effect, so a caller can name the address it found.
cove_is_serving() {
  command -v curl >/dev/null 2>&1 || return 1
  [ -n "${COVE_SERVING_NODE:-}" ] || return 1
  [ -n "${COVE_SERVING_REPO_DIR:-}" ] || return 1
  cove_web_base_configured || return 1
  if [ -z "$COVE_WEB_PORT" ]; then
    COVE_WEB_PORT="$("$COVE_SERVING_NODE" \
      "$COVE_SERVING_REPO_DIR/scripts/lib/cove-install-runtime.mjs" \
      "$COVE_SERVING_REPO_DIR" port 2>/dev/null || true)"
  fi
  [ -n "$COVE_WEB_PORT" ] || return 1
  # The body has to look like Cove's own, so another program on that port cannot
  # block a recovery or be reported as Cove running.
  curl -fsS -m 3 "http://127.0.0.1:$COVE_WEB_PORT/api/health" 2>/dev/null |
    grep -q '"readiness"'
}
