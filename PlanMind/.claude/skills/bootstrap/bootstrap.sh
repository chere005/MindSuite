#!/usr/bin/env bash
# macOS/Linux setup. Sourceable for offline tests; only main dispatches steps.
set -euo pipefail
DRY=0
PM=""
SUITE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

say() { printf '==> %s\n' "$*"; }
warn() { printf '    ! %s\n' "$*" >&2; }
run() {
  if [ "$DRY" = 1 ]; then printf '    would: '; printf '%q ' "$@"; printf '\n'
  else "$@"; fi
}

load_config() {
  BOOTSTRAP_HOME="${BOOTSTRAP_HOME:-$HOME}"
  CONF="${BOOTSTRAP_CONF:-${XDG_CONFIG_HOME:-$BOOTSTRAP_HOME/.config}/agentsuite/bootstrap.conf}"
  # Preserve explicitly set environment values, including deliberately empty ones.
  local names=(MIND_DIR GIT_NAME GIT_EMAIL GH_OWNER REPOS SITE_REPO SUITE_DEPLOY_HOST GIT_PROTOCOL)
  local values=() present=() key i
  for key in "${names[@]}"; do values+=("${!key-}"); present+=("${!key+x}"); done
  if [ -f "$CONF" ]; then . "$CONF"; fi
  for ((i=0; i<${#names[@]}; i++)); do
    if [ "${present[$i]}" = x ]; then printf -v "${names[$i]}" '%s' "${values[$i]}"; fi
  done
  MIND_DIR="${MIND_DIR:-$BOOTSTRAP_HOME/GIT}"
  GIT_NAME="${GIT_NAME:-}"; GIT_EMAIL="${GIT_EMAIL:-}"; GH_OWNER="${GH_OWNER:-}"
  REPOS="${REPOS:-}"; SITE_REPO="${SITE_REPO:-}"; SUITE_DEPLOY_HOST="${SUITE_DEPLOY_HOST:-}"
  GIT_PROTOCOL="${GIT_PROTOCOL:-https}"
  case "$GIT_PROTOCOL" in https|ssh) ;; *) warn 'GIT_PROTOCOL must be https or ssh'; return 1;; esac
  GH_KEY="$BOOTSTRAP_HOME/.ssh/id_ed25519"; NFSN_KEY="$BOOTSTRAP_HOME/.ssh/id_nfsn"
}

need() {
  local key="$1" value="${!1-}"
  [ -z "$value" ] || return 0
  if [ "$DRY" = 1 ]; then say "would ask for $key"; return 0; fi
  [ -t 0 ] || { warn "$key is required; set it in $CONF or the environment"; return 1; }
  printf '    %s: ' "$2" >&2; read -r value
  [ -n "$value" ] || { warn "$key is empty"; return 1; }
  printf -v "$key" '%s' "$value"
  (umask 077; mkdir -p "$(dirname "$CONF")"; printf '%s=%q\n' "$key" "$value" >> "$CONF"; chmod 600 "$CONF")
}

gate() { warn "$*"; return 10; }
detect_pm() {
  case "$(uname -s)" in
    Darwin) if command -v brew >/dev/null 2>&1; then PM=brew; else PM=brew-missing; fi;;
    Linux) if command -v pacman >/dev/null 2>&1; then PM=pacman
      elif command -v apt-get >/dev/null 2>&1; then PM=apt
      elif command -v dnf >/dev/null 2>&1; then PM=dnf; else PM=unknown; fi;;
    *) PM=unsupported;;
  esac
}

# -F excludes unrelated config; IdentitiesOnly restricts agent keys to the selected identity.
# GitHub exits 1 after successful authentication because it provides no shell.
github_ok() {
  local answer
  answer="$(ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes \
    -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -i "$GH_KEY" -T git@github.com 2>&1 || true)"
  case "$answer" in *'successfully authenticated'*) return 0;; *) return 1;; esac
}
nfsn_ok() {
  [ -n "$SUITE_DEPLOY_HOST" ] || return 1
  ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes \
    -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -i "$NFSN_KEY" "$SUITE_DEPLOY_HOST" true
}

jdk_on_path() {
  if [ "$DRY" = 1 ]; then say 'would configure Homebrew JAVA_HOME'; return 0; fi
  local jdk rc
  jdk="$(brew --prefix)/opt/openjdk"
  [ -x "$jdk/bin/java" ] || { warn 'Homebrew JDK is missing'; return 1; }
  for rc in "$BOOTSTRAP_HOME/.zshrc" "$BOOTSTRAP_HOME/.bash_profile"; do
    [ -f "$rc" ] || [ "$rc" = "$BOOTSTRAP_HOME/.zshrc" ] || continue
    if ! grep -qF '# >>> AgentSuite bootstrap (jdk) >>>' "$rc" 2>/dev/null; then
      { printf '\n# >>> AgentSuite bootstrap (jdk) >>>\nexport JAVA_HOME=%q\n' "$jdk"
        printf 'export PATH="$JAVA_HOME/bin:$PATH"\n# <<< AgentSuite bootstrap (jdk) <<<\n'; } >> "$rc"
    fi
  done
  export JAVA_HOME="$jdk"
  export PATH="$JAVA_HOME/bin:$PATH"
}

step_packages() {
  say "packages ($PM)"
  case "$PM" in
    brew-missing) gate 'Install Homebrew using https://brew.sh, then rerun packages';;
    brew)
      run brew install git python gh node rsync php rust cocoapods watchman jq openjdk gradle
      run brew install --cask android-platform-tools firefox sublime-text sublime-merge rectangle
      jdk_on_path;;
    pacman)
      run sudo pacman -S --needed --noconfirm git python python-pip github-cli nodejs npm rsync php curl rust jq stow firefox
      # the owner's desktop selection; audio packages and automatic dotfile moves are excluded.
      run sudo pacman -S --needed --noconfirm i3-wm i3lock polybar rofi picom kitty xfce4-session \
        thunar xfce4-screenshooter openbox xorg-server xorg-xinit xorg-xrandr xorg-xrdb feh \
        xbindkeys dex xss-lock network-manager-applet scrot xclip ttf-firacode-nerd;;
    apt)
      run sudo apt-get update
      run sudo apt-get install -y git python3 python3-pip gh nodejs npm rsync php-cli curl;;
    dnf) run sudo dnf install -y git python3 gh nodejs npm rsync php-cli curl;;
    *) warn 'Package setup supports macOS/Homebrew and Linux/pacman, apt, dnf; use native setup on Windows'; return 1;;
  esac
}
step_claude() {
  if [ "$PM" = brew ]; then run brew install --cask claude claude-code
  elif command -v claude >/dev/null 2>&1; then say 'Claude Code is installed'
  elif [ "$DRY" = 1 ]; then say 'would run the official Claude Code Linux installer'
  else
    local installer
    installer="$(mktemp)"
    if ! curl -fsSL https://claude.ai/install.sh -o "$installer"; then rm -f "$installer"; return 1; fi
    if bash "$installer"; then rm -f "$installer"; else rm -f "$installer"; return 1; fi
  fi
}
step_identity() {
  need GIT_NAME 'Git commit name'; need GIT_EMAIL 'Git commit email (noreply is supported)'
  run git config --global user.name "$GIT_NAME"
  run git config --global user.email "$GIT_EMAIL"
}

configure_key() {
  local key="$1" host="$2" label="$3" config="$BOOTSTRAP_HOME/.ssh/config"
  local escaped="${key//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  if [ ! -f "$key" ]; then
    [ -t 0 ] || { gate "Create $key with ssh-keygen interactively, then rerun keys"; return 10; }
    ssh-keygen -t ed25519 -C "$label" -f "$key"
  fi
  # A passphrase-protected key can authenticate through its matching agent identity.
  if [ "$(uname -s)" = Darwin ]; then
    if ! ssh-add --apple-use-keychain "$key"; then warn "Unlock $key in ssh-agent if authentication fails"; fi
  else
    if ! ssh-add "$key"; then warn "Unlock $key in ssh-agent if authentication fails"; fi
  fi
  local marker="# AgentSuite key: $host"
  if ! grep -qF "$marker" "$config" 2>/dev/null; then
    { printf '\n%s\nHost %s\n  IdentityFile "%s"\n  IdentitiesOnly yes\n  AddKeysToAgent yes\n' "$marker" "$host" "$escaped"
      if [ "$(uname -s)" = Darwin ]; then printf '  UseKeychain yes\n'; fi; } >> "$config"
    chmod 600 "$config"
  fi
}
step_keys() {
  if [ "$DRY" = 1 ]; then say 'would configure separate SSH keys for the selected SSH services'; return 0; fi
  if [ "$GIT_PROTOCOL" != ssh ] && [ -z "$SUITE_DEPLOY_HOST" ]; then say 'no SSH services selected'; return 0; fi
  (umask 077; mkdir -p "$BOOTSTRAP_HOME/.ssh"); chmod 700 "$BOOTSTRAP_HOME/.ssh"
  if [ "$GIT_PROTOCOL" = ssh ]; then
    configure_key "$GH_KEY" github.com "$GIT_EMAIL $(hostname -s)"
    if ! github_ok; then cat "$GH_KEY.pub"; gate 'Authorize the GitHub public key at https://github.com/settings/ssh/new'; return 10; fi
  fi
  if [ -n "$SUITE_DEPLOY_HOST" ]; then
    configure_key "$NFSN_KEY" '*.nearlyfreespeech.net' "$GIT_EMAIL $(hostname -s) (nfsn)"
    if ! nfsn_ok; then cat "$NFSN_KEY.pub"; gate 'Authorize the NFSN public key in the member profile'; return 10; fi
  fi
}

valid_repo() { [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; }
step_clone() {
  need GH_OWNER 'GitHub repository owner'
  if [ "$DRY" = 1 ]; then say "would discover/update selected $GH_OWNER repositories in $MIND_DIR ($GIT_PROTOCOL)"; return 0; fi
  [[ "$GH_OWNER" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || { warn "Invalid GitHub owner"; return 1; }
  if [ -z "$REPOS" ]; then
    gh auth status >/dev/null 2>&1 || { warn 'Authenticate with gh auth login'; return 1; }
    REPOS="$(gh api --paginate "user/repos?per_page=100&affiliation=owner,collaborator,organization_member" \
      --jq ".[] | select((.owner.login | ascii_downcase) == (\"$GH_OWNER\" | ascii_downcase) and .fork == false and .archived == false) | .name")"
    [ -n "$REPOS" ] || { warn "No source repositories returned for $GH_OWNER"; return 1; }
  fi
  mkdir -p "$MIND_DIR"
  local repo path url status conflicts bad=0 repositories=()
  read -r -a repositories <<< "${REPOS//$'\n'/ }"
  for repo in "${repositories[@]}"; do
    valid_repo "$repo" || { warn "Invalid repository name: $repo"; bad=1; continue; }
    path="$MIND_DIR/$repo"
    if [ -e "$path" ]; then
      if ! git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then warn "$repo: destination is not a checkout"; bad=1; continue; fi
      if ! status="$(git -C "$path" status --porcelain)"; then bad=1; continue; fi
      # Never stash another session's in-progress work during machine setup.
      if [ -n "$status" ]; then warn "$repo: local changes; skipped"; bad=1; continue; fi
      if git -C "$path" pull --ff-only; then
        if conflicts="$(git -C "$path" ls-files --unmerged)" && [ -z "$conflicts" ]; then say "$repo: updated"
        else warn "$repo: unresolved conflicts"; bad=1; fi
      else warn "$repo: pull failed"; bad=1; fi
    else
      if [ "$GIT_PROTOCOL" = ssh ]; then url="git@github.com:$GH_OWNER/$repo.git"
      else url="https://github.com/$GH_OWNER/$repo.git"; fi
      if git clone "$url" "$path"; then say "$repo: cloned"; else warn "$repo: clone failed"; bad=1; fi
    fi
  done
  return "$bad"
}
step_deploy() {
  if [ -z "$SITE_REPO" ]; then say 'no deployment checkout selected'; return 0; fi
  valid_repo "$SITE_REPO" || { warn 'SITE_REPO must be a repository name'; return 1; }
  if [ "$DRY" = 1 ]; then say "would configure $MIND_DIR/$SITE_REPO/deploy.conf from SUITE_DEPLOY_HOST"; return 0; fi
  local site="$MIND_DIR/$SITE_REPO"
  [ -f "$site/deploy.sh" ] || { warn "$SITE_REPO: deploy.sh is missing"; return 1; }
  if [ -f "$site/deploy.conf" ]; then say 'deploy.conf already exists'; return 0; fi
  [ -n "$SUITE_DEPLOY_HOST" ] || { gate 'Set SUITE_DEPLOY_HOST from the NFSN Site Information panel'; return 10; }
  (umask 077; printf 'HOST=%q\n' "$SUITE_DEPLOY_HOST" > "$site/deploy.conf")
}
step_hook() {
  local installer="$SUITE_ROOT/tools/install.py"
  if [ ! -f "$installer" ]; then installer="$MIND_DIR/AgentSuite/tools/install.py"; fi
  if [ "$DRY" = 0 ] && [ ! -f "$installer" ]; then warn 'Clone AgentSuite before installing its hook'; return 1; fi
  run python3 "$installer" hook "$BOOTSTRAP_HOME/.claude"
}
step_verify() {
  if [ "$DRY" = 1 ]; then say 'would verify toolchains, authentication, repositories and the selected site tests'; return 0; fi
  local bad=0 command_name repo log
  local commands=(git python3 gh node rsync php curl)
  if [ "$PM" = brew ]; then commands+=(cargo pod adb jq); fi
  for command_name in "${commands[@]}"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then warn "$command_name: missing"; bad=1; fi
  done
  if [ "$PM" = brew ] && ! xcodebuild -version >/dev/null 2>&1; then warn 'Full Xcode is required for native Apple builds'; bad=1; fi
  if ! gh auth status >/dev/null 2>&1; then warn 'GitHub CLI authentication failed'; bad=1; fi
  if [ "$GIT_PROTOCOL" = ssh ] && ! github_ok; then warn 'GitHub SSH authentication failed'; bad=1; fi
  if [ -n "$SUITE_DEPLOY_HOST" ] && ! nfsn_ok; then warn 'NFSN authentication failed'; bad=1; fi
  if [ -n "$REPOS" ]; then
    local repositories=()
    read -r -a repositories <<< "${REPOS//$'\n'/ }"
    for repo in "${repositories[@]}"; do
      if ! valid_repo "$repo" || [ ! -e "$MIND_DIR/$repo/.git" ]; then warn "$repo: missing checkout"; bad=1; fi
    done
  fi
  if [ -n "$SITE_REPO" ]; then
    if ! valid_repo "$SITE_REPO" || [ ! -f "$MIND_DIR/$SITE_REPO/tools/test.php" ]; then warn 'Selected site test script is missing'; bad=1
    else
      log="$(mktemp)"
      if (cd "$MIND_DIR/$SITE_REPO" && php tools/test.php) > "$log" 2>&1; then tail -1 "$log"; rm -f "$log"
      else warn "Site tests failed; output in $log"; bad=1; fi
    fi
  fi
  if [ "$bad" = 0 ]; then say 'selected checks passed'; else return 1; fi
}

main() {
  local steps=() arg step
  for arg in "$@"; do
    case "$arg" in
      -n|--dry-run) DRY=1;;
      -h|--help|-l|--list) printf '%s\n' 'Usage: bootstrap.sh [-n] [packages claude identity keys clone deploy hook verify]' 'No steps: all. Exit 0: success; 10: human setup required; 1: failure.'; return 0;;
      packages|claude|identity|keys|clone|deploy|hook|verify) steps+=("$arg");;
      *) warn "Unknown step: $arg"; return 1;;
    esac
  done
  load_config
  detect_pm
  if [ "$PM" = unsupported ]; then warn 'Use native Windows tool setup; tools/install.py supports Windows'; return 1; fi
  if [ -z "${steps[0]+x}" ]; then steps=(packages claude identity keys clone deploy hook verify); fi
  if [ "$DRY" = 1 ]; then say 'DRY RUN: no setup commands or authentication probes will run'; fi
  for step in "${steps[@]}"; do "step_$step"; done
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
