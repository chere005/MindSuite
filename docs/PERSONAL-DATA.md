# Personal data and names

No account name and no person's name may appear in a tracked file, a path, a test fixture, a comment, a doc or a commit message. Code speaks in roles (`owner`, `partner`, `both`); fixtures use the placeholder ids `alex` (owner) and `sam` (partner). Real ids exist only in each deployed app's private server config.

## Checks

| Check | What it covers | Needs |
| --- | --- | --- |
| `CoreMind/bin/check-personal-data.sh` | device ids, team ids, mail addresses, home paths, machine values, local digest list | local lists, skipped without |
| `CoreMind/bin/check-names.sh tree` | every tracked file and path at `HEAD` against the needle list | the needle list |
| `CoreMind/bin/check-names.sh literals` | an account-like id in a person context (`owners`, `partner`, `createdBy`, `users` map keys, `by=`, `KEEP`, `records-<x>.json`, `<x>@example.com`) that is not in `CoreMind/bin/placeholder-ids.txt` | nothing, so CI runs it |
| `check-names.sh staged` / `message` / `history` / `mirror` | a commit's change, its message, whole ancestry including tags, ref names and every blob | the needle list |

`check-names.sh` prints `path:line`, a rule and a needle number (`#k`) only. It never prints a needle or the matched token; a path that contains one is shown with `<NAME>` in its place.

## Needle list

The list is untracked and lives outside every repository: `~/Library/Application Support/MindSuite/needles.txt` (mode 600), or the file named by `MIND_NEEDLES`. `sh CoreMind/bin/needles-init.sh` builds it from the local scrub-rule files and the `PERSON_*` values of the apps' `.local/machine.env`, and prints only a count. Beside it, `needle-allow.sha256` holds hashes of lowercase tokens, or of `path NUL line`, that may pass (for example the site's domain). Nothing name-derived is ever tracked: no hash list either, because a list of short-name digests is a dictionary oracle.

## Matching

- Tokens are `[A-Za-z0-9_]+`; subwords split on `_`, digits and camelCase.
- A needle shorter than 5 letters hits when a subword or a whole letter run equals it, equals it plus `s`/`es`, or starts or ends with it. `azqxb`-style mid-word occurrences stay clean.
- A needle of 5 or more letters hits as a case-insensitive substring.
- Text is folded before matching: accents, combining marks and invisible format characters are removed (`é`, `e` + U+0301 and a zero-width split all hit like the plain word), and needles are folded the same way. A path printed with `<NAME>` is shown in its folded form.
- Binary blobs are searched for long needles; PNG text chunks and JPEG/EXIF strings are decoded and searched; base64 runs of 40+ characters are decoded and searched for long needles.

## Ratchet, then strict

Until the strict marker `CoreMind/bin/names-strict` exists, `preflight` runs `tree` and `literals` with `--ratchet auto`: the per-needle count at `HEAD` may not exceed the count at `git merge-base HEAD main`, computed live (no baseline file; on `main` itself the base is `HEAD^`; with no `main` or `origin/main` it exits 2; the summary prints the resolved commit), so moves and copy-then-delete steps pass. Paths listed in `CoreMind/bin/names-ratchet-exempt.txt` are skipped by every ratchet run (a copy that lands before its original is deleted, as in monorepo W2 P2.1; remove the line in the wave that deletes the original); strict zero ignores that file. `staged` allows a net added-minus-removed of 0 or less per needle and 0 in the path of an added file. `message` and `history` are hard gates; `message` reads every line, `#` lines too (they stay in the stored message with `-m`/`-F`), except git's own editor-template file listings of paths in the change, and `commit -v` diff text counts. With the marker (or `MIND_NAMES_STRICT=1`) every rule requires zero. The marker is committed: `preflight` now runs `tree` and `literals` without `--ratchet`, and pre-commit (`staged`), commit-msg (`message`) and pre-push (`history`) require zero.

## Hooks

`tools/githooks` (set once per clone: `git config core.hooksPath tools/githooks`): `pre-commit` runs `staged`, `commit-msg` runs `message`, `pre-push` runs AgentSuite's pre-push and then `history <local> --not <remote tip>` for every pushed ref. For a remote listed in `git config --get-all mindsuite.publicRemote` it scans the whole ancestry and accepts only `refs/heads/main`, release tags `<App>/<x.y.z>` and the lanes' `preflight/<app>/<sha>` branches (docs/PUBLISH.md, "Lanes and the public remote"). Without a needle list `staged`, `message`, `history` and `mirror` exit 2; a public remote never skips (the hook clears `MIND_NAMES_OPTIONAL`); only CI sets `MIND_NAMES_OPTIONAL=1`, which skips the needle rules and still runs `literals`.

## After publishing

Clone the public repository anonymously with `git clone --mirror` into a fresh directory and run `sh CoreMind/bin/check-names.sh mirror DIR` (all refs, including `refs/pull/*`), then scan the repository's description, topics, releases, issues and pull requests through the API.
