#!/bin/sh
set -eu

if [ -f /tmp/openeral-session.env ]; then
  # shellcheck disable=SC1091
  . /tmp/openeral-session.env
fi

export HOME="${HOME:-/home/agent}"
export SHELL="${SHELL:-/bin/bash}"
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"

# These are setup-only credentials. Claude should see the provider API key
# placeholder when present, but not the StringCost management key.
unset STRINGCOST_API_KEY
unset ANTHROPIC_AUTH_TOKEN

if [ ! -x /usr/local/bin/claude-real ]; then
  echo "openeral: claude-real is missing; the sandbox image did not install Claude Code correctly" >&2
  exit 127
fi

exec /usr/local/bin/claude-real "$@"
