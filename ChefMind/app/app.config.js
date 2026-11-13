/**
 * app.json stays the source of truth; this wrapper adds the one value that must
 * not live in a tracked file: the Apple team that signs the device build. The
 * lanes export APPLE_TEAM_ID from the untracked .local/machine.env
 * (tools/machine-env.sh); a run without it simply has no team to sign with.
 */
module.exports = ({ config }) => {
  const team = process.env.APPLE_TEAM_ID;
  return team ? { ...config, ios: { ...config.ios, appleTeamId: team } } : config;
};
