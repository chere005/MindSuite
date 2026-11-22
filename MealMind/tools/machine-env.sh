#!/bin/sh
# Machine- and person-specific values for the lanes, read from an UNTRACKED
# file so no tracked file carries a device, a team or a person.
#
#   . "$ROOT/tools/machine-env.sh"      (from a lane; ROOT = the app checkout)
#   machine_load "$ROOT"                find and source <ROOT>/.local/machine.env
#   machine_require KEY ...             exit 1, naming the key, if it is unset
#   machine_team                        APPLE_TEAM_ID, required
#   machine_phones <APP>                one "<udid>  # <name> (<person>)" line per
#                                       phone listed in <APP>_PHONES
#
# The file is <ROOT>/.local/machine.env (MIND_MACHINE_ENV names another one,
# which is how a test points a lane at its disposable fixture). It is plain
# sh: KEY=value lines. tools/machine.env.sample shows every key with
# placeholder values; copy it to .local/machine.env and fill it in. The
# file is gitignored, and CoreMind's check-personal-data.sh fails if any value
# in it appears in a tracked file.
#
# A lane that needs a value and has no file STOPS and says which key and which
# file. There is no default, because a default is a literal in a tracked file.

machine_file() { printf '%s' "${MIND_MACHINE_ENV:-$1/.local/machine.env}"; }

machine_load() { # root
  MACHINE_ENV_FILE=$(machine_file "$1")
  if [ ! -f "$MACHINE_ENV_FILE" ]; then
    echo "machine-env: $MACHINE_ENV_FILE does not exist." >&2
    echo "  It holds this machine's device UDIDs, Apple team and people, and is never committed." >&2
    echo "  Copy tools/machine.env.sample to .local/machine.env (or from another checkout) and fill it in." >&2
    return 1
  fi
  # shellcheck disable=SC1090
  . "$MACHINE_ENV_FILE"
}

machine_require() { # KEY ...
  for _k in "$@"; do
    eval "_v=\${$_k:-}"
    if [ -z "$_v" ]; then
      echo "machine-env: key $_k is missing or empty in ${MACHINE_ENV_FILE:-the machine env file}" >&2
      return 1
    fi
  done
}

machine_team() {
  machine_require APPLE_TEAM_ID || return 1
  printf '%s' "$APPLE_TEAM_ID"
}

# Phone indexes for an app come from <APP>_PHONES (space separated, e.g. "1 2");
# each index N names PHONE<N>_UDID, PHONE<N>_NAME and PHONE<N>_PERSON.
machine_phones() { # APP
  _app=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  machine_require "${_app}_PHONES" || return 1
  eval "_list=\${${_app}_PHONES}"
  for _n in $_list; do
    machine_require "PHONE${_n}_UDID" "PHONE${_n}_NAME" "PHONE${_n}_PERSON" || return 1
    eval "_u=\$PHONE${_n}_UDID; _nm=\$PHONE${_n}_NAME; _p=\$PHONE${_n}_PERSON"
    printf '%s  # %s, %s\n' "$_u" "$_nm" "$_p"
  done
}

# One phone's value by index: machine_phone 2 UDID|NAME|PERSON
machine_phone() {
  machine_require "PHONE${1}_${2}" || return 1
  eval "printf '%s' \"\$PHONE${1}_${2}\""
}
