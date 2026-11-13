---
name: bootstrap
description: Set up or repair a development machine using AgentSuite's bootstrap script, including toolchains, Git authentication and local deployment configuration.
---

# Machine setup

Use `bootstrap.sh` for macOS/Homebrew or Linux/pacman, apt and dnf. Windows package installation is outside this script; use native tools there and `tools/install.py` from the canonical AgentSuite checkout for shared instructions and skills.

```sh
bash skills/bootstrap/bootstrap.sh --help
bash skills/bootstrap/bootstrap.sh -n
bash skills/bootstrap/bootstrap.sh clone verify
```

- Inspect [bootstrap.conf.sample](bootstrap.conf.sample). Configuration is a **trusted Bash file** outside Git; environment values take precedence. Do not source an unreviewed configuration. A dry run neither prompts nor executes setup/authentication commands.
- Steps run in the requested order, or `packages claude identity keys clone deploy hook verify` by default. Choose only the steps the request needs. `claude` installs Claude; it does not change the user's chosen agent for other work.
- HTTPS is the Git default and uses existing credentials. Choose `GIT_PROTOCOL=ssh` for SSH. Separate GitHub and NFSN keys are used when those services are selected. New key generation is interactive; exit 10 means human setup is required.
- Repository discovery includes accessible private repositories owned by `GH_OWNER` and excludes forks and archived repos. Existing dirty checkouts are skipped; updates allow only fast-forwards. Failed operations return nonzero.
- macOS uses Homebrew for packages and casks. Native Apple builds need full Xcode. The Arch desktop selection excludes audio packages; dotfiles are never moved automatically. Linux recipes remain subject to validation on the target distribution.
- `SITE_REPO` and `SUITE_DEPLOY_HOST` opt into local deployment configuration. Existing `deploy.conf` is preserved. The script never deploys.
- The hook step needs the canonical AgentSuite checkout (normally `$MIND_DIR/AgentSuite`) because its installer and hook live there. `verify` checks configured authentication and site tests; it does not prove every application builds.

Use disposable fixtures and stub `ssh`, package managers and deployment commands when changing this script. For toolchain requirements, consult the application being built; do not install every suite platform to fix one missing tool.
