# Find a working Python 3 (sourced, POSIX sh). ChefMind's own copy, used by
# deploy.sh; not canon. The suite's root scripts use CoreMind/bin/python.sh.
#
#   . tools/python.sh
#   mind_python || exit 1
#   $MIND_PYTHON - "$@" <<'PY'      # unquoted on purpose: it may be "py -3"
#
# Takes the first of python3, python, "py -3" that runs Python 3.8 or newer.
# On Windows `python3` is often the Microsoft Store stub, which prints an
# install hint and fails; it is skipped like any other non-working candidate.
# With none working, says so on stderr and returns 1, so the caller stops
# rather than skipping whatever the Python was there to check.
mind_python() {
  for _mp_try in python3 python "py -3"; do
    if $_mp_try -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
      MIND_PYTHON=$_mp_try
      unset _mp_try
      return 0
    fi
  done
  unset _mp_try
  echo "no working Python 3.8+ found (tried python3, python, py -3): install Python 3 and put it on PATH" >&2
  return 1
}
