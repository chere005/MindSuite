import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const repository = 'chere005/MindSuite';
export const workflowPath = '.github/workflows/planmind-release.yml';
const fixturePrefix = '.github/planmind-posix/';
export const gateName = 'PlanMind POSIX gates';
export const requiredSteps = [
  'Check out gate fixtures', 'Check out exact source', 'Set up Node', 'Set up PHP',
  'Verify source and POSIX filesystem', 'Install PlanMind dependencies',
  'Run server checks', 'Run atomic checks', 'Run deployment harness', 'Check link-swap mutation',
];
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const git = (...args) => run('git', args);
const api = endpoint => JSON.parse(run('gh', ['api', endpoint]));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const blobSha = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
const branchFor = sha => `preflight/planmind-posix/${sha.slice(0, 12)}`;
const gitHubExpression = expression => '${{ ' + expression + ' }}';

export function makeWorkflow(sourceSha, fixtureDigest) {
  assert.match(sourceSha, /^[0-9a-f]{40}$/);
  assert.match(fixtureDigest, /^[0-9a-f]{64}$/);
  return `name: PlanMind POSIX preflight
on:
  workflow_dispatch:
    inputs:
      preflight:
        type: boolean
        default: true
permissions:
  contents: read
concurrency:
  group: ${gitHubExpression("github.triggering_actor != 'github-actions[bot]' && format('handoff-{0}', github.run_id) || format('planmind-posix-{0}', github.sha)")}
  cancel-in-progress: false
jobs:
  handoff:
    if: github.triggering_actor != 'github-actions[bot]'
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    continue-on-error: true
    permissions:
      actions: write
      contents: read
    env:
      GH_TOKEN: ${gitHubExpression('github.token')}
    steps:
      - name: Hand off to the bot
        run: gh workflow run planmind-release.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" -f preflight=true
  posix:
    name: ${gateName}
    if: github.triggering_actor == 'github-actions[bot]' && inputs.preflight == true
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    continue-on-error: true
    env:
      PLANMIND_TEST_SITE_LIB: ${gitHubExpression('github.workspace')}/gate/.github/planmind-posix/site-lib
    defaults:
      run:
        working-directory: source/PlanMind
    steps:
      - name: Check out gate fixtures
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
        with:
          ref: ${gitHubExpression('github.sha')}
          path: gate
          persist-credentials: false
      - name: Check out exact source
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
        with:
          ref: ${sourceSha}
          path: source
          persist-credentials: false
      - name: Set up Node
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444
        with:
          node-version: 24
      - name: Set up PHP
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y php-cli php-cgi php-mbstring
          php -r 'exit(PHP_VERSION_ID >= 80200 && extension_loaded("openssl") && extension_loaded("mbstring") ? 0 : 1);'
      - name: Verify source and POSIX filesystem
        run: |
          set -eu
          test "$(git rev-parse HEAD)" = ${sourceSha}
          test -z "$(git status --porcelain)"
          printf '%s  %s\\n' '${fixtureDigest}' "$GITHUB_WORKSPACE/gate/.github/planmind-posix/manifest.json" | sha256sum -c -
          probe=$(mktemp -d)
          trap 'rm -rf "$probe"' EXIT
          touch "$probe/file"
          chmod 600 "$probe/file"
          test "$(stat -c %a "$probe/file")" = 600
          ln -s file "$probe/link"
          test -L "$probe/link"
      - name: Install PlanMind dependencies
        run: npm ci
      - name: Run server checks
        run: npm run test:server
      - name: Run atomic checks
        run: npm run test:atomic
      - name: Run deployment harness
        run: npm run test:deploy
      - name: Check link-swap mutation
        env:
          MUT_ONLY: ^non-atomic-mv$
        run: npm run test:deploy:mutations
`;
}

function fixture() {
  const lib = process.env.PLANMIND_TEST_SITE_LIB;
  assert.ok(lib, 'PLANMIND_TEST_SITE_LIB must name the current site checkout lib');
  const siteRoot = run('git', ['rev-parse', '--show-toplevel'], lib);
  const siteGit = (...args) => run('git', args, siteRoot);
  assert.equal(siteGit('remote', 'get-url', 'origin'), 'git@github.com:chere005/seancheren-site.git', 'unexpected site repository');
  assert.equal(siteGit('status', '--porcelain', '--untracked-files=no', '--', 'lib'), '', 'site library has uncommitted changes');
  const siteCommit = siteGit('rev-parse', 'HEAD');
  const files = siteGit('ls-tree', '-r', 'HEAD', '--', 'lib').split('\n').flatMap(line => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\tlib\/([^/]+\.php)$/.exec(line);
    if (!match || /^config(?:\..*)?\.php$/i.test(match[3])) return [];
    const bytes = execFileSync('git', ['show', `${siteCommit}:lib/${match[3]}`], { cwd: siteRoot });
    assert.equal(blobSha(bytes), match[2]);
    return [{ name: match[3], sha: match[2], bytes }];
  });
  assert.ok(files.some(file => file.name === 'mindsuite-site-auth.php') && files.some(file => file.name === 'auth.php'), 'site fixture library is incomplete');
  const manifestText = JSON.stringify({ schema: 1, repository: 'chere005/seancheren-site', commit: siteCommit, files: files.map(({ name, sha }) => ({ name, sha })) }, null, 2) + '\n';
  return { files, manifestText };
}

export function validateGate(expected, observed) {
  const { sourceSha, manifestText } = expected;
  const { run: result, workflow, sourceParent, branchSha, mainSha, jobs, workflowText, fixtureEntries } = observed;
  assert.equal(mainSha, sourceSha, 'remote main changed after the gate');
  assert.equal(result.repository?.full_name, repository, 'wrong run repository');
  assert.equal(result.head_repository?.full_name, repository, 'wrong source repository');
  assert.equal(result.workflow_id, workflow.id, 'wrong workflow');
  assert.equal(workflow.path, workflowPath, 'wrong workflow path');
  assert.equal(result.path?.split('@')[0], workflowPath, 'wrong run workflow path');
  assert.equal(result.event, 'workflow_dispatch', 'gate must be manually dispatched');
  assert.equal(result.triggering_actor?.login, 'github-actions[bot]', 'the bot must run the gate');
  assert.equal(result.head_branch, branchFor(sourceSha), 'wrong preflight branch');
  assert.equal(sourceParent, sourceSha, 'gate branch is not based on this source commit');
  assert.equal(branchSha, result.head_sha, 'preflight branch changed after the run');
  assert.equal(result.status, 'completed', 'gate has not completed');
  assert.equal(result.conclusion, 'success', 'gate run did not succeed');
  assert.equal(workflowText, makeWorkflow(sourceSha, sha256(manifestText)), 'workflow definition differs from the required gates');
  const expectedEntries = [{ path: fixturePrefix + 'manifest.json', sha: blobSha(manifestText), mode: '100644', type: 'blob' },
    ...JSON.parse(manifestText).files.map(({ name, sha }) => ({ path: fixturePrefix + 'site-lib/' + name, sha, mode: '100644', type: 'blob' }))];
  const sorted = entries => [...entries].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(sorted(fixtureEntries.filter(entry => entry.type !== 'tree')), sorted(expectedEntries), 'tracked site fixture provenance differs');
  const matches = jobs.filter(job => job.name === gateName);
  assert.equal(matches.length, 1, 'expected exactly one POSIX gate job');
  const job = matches[0];
  assert.equal(job.head_sha, result.head_sha, 'job source differs from the run');
  assert.equal(job.status, 'completed', 'gate job has not completed');
  assert.equal(job.conclusion, 'success', 'gate job did not succeed');
  for (const name of requiredSteps) {
    const steps = job.steps.filter(step => step.name === name);
    assert.equal(steps.length, 1, `missing or repeated gate step: ${name}`);
    assert.equal(steps[0].status, 'completed', `gate step has not completed: ${name}`);
    assert.equal(steps[0].conclusion, 'success', `gate step did not succeed: ${name}`);
  }
  assert.ok(job.steps.every(step => !['failure', 'cancelled', 'timed_out', 'action_required'].includes(step.conclusion)), 'gate contains a failed step');
}

function currentSource() {
  assert.equal(git('remote', 'get-url', 'origin'), 'git@github.com:chere005/MindSuite.git', 'unexpected source repository');
  assert.equal(git('branch', '--show-current'), 'main', 'release main only');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'commit reviewed source before checking POSIX proof');
  return git('rev-parse', 'HEAD');
}

async function main() {
  const [command, output] = process.argv.slice(2);
  const sourceSha = currentSource();
  const site = fixture();
  if (command === 'prepare') {
    assert.ok(output && path.isAbsolute(output), 'prepare needs an absolute output directory');
    const fixtureDir = path.join(output, fixturePrefix);
    mkdirSync(path.join(fixtureDir, 'site-lib'), { recursive: true });
    mkdirSync(path.join(output, path.dirname(workflowPath)), { recursive: true });
    for (const file of site.files) writeFileSync(path.join(fixtureDir, 'site-lib', file.name), file.bytes);
    writeFileSync(path.join(fixtureDir, 'manifest.json'), site.manifestText);
    writeFileSync(path.join(output, workflowPath), makeWorkflow(sourceSha, sha256(site.manifestText)));
    console.log(JSON.stringify({ sourceSha, branch: branchFor(sourceSha), files: site.files.length, output }));
    return;
  }
  assert.equal(command, 'verify', 'use prepare <directory> or verify');
  const id = process.env.PLANMIND_POSIX_RUN;
  assert.match(id ?? '', /^[1-9][0-9]*$/, 'PLANMIND_POSIX_RUN must name a genuine completed hosted gate');
  const prefix = `repos/${repository}`;
  const result = api(`${prefix}/actions/runs/${id}`);
  assert.match(result.head_sha, /^[0-9a-f]{40}$/);
  const contents = api(`${prefix}/contents/${workflowPath}?ref=${result.head_sha}`);
  const tree = api(`${prefix}/git/trees/${result.head_sha}?recursive=1`);
  assert.equal(tree.truncated, false, 'incomplete gate tree');
  const commit = api(`${prefix}/git/commits/${result.head_sha}`);
  assert.equal(commit.parents.length, 1, 'unexpected gate commit ancestry');
  const jobs = api(`${prefix}/actions/runs/${id}/jobs?per_page=100`);
  assert.ok(jobs.total_count <= 100, 'unexpected job pagination');
  validateGate({ sourceSha, manifestText: site.manifestText }, {
    run: result,
    workflow: api(`${prefix}/actions/workflows/planmind-release.yml`),
    sourceParent: commit.parents[0].sha,
    branchSha: api(`${prefix}/git/ref/heads/${branchFor(sourceSha)}`).object.sha,
    mainSha: api(`${prefix}/branches/main`).commit.sha,
    jobs: jobs.jobs,
    workflowText: Buffer.from(contents.content, 'base64').toString('utf8'),
    fixtureEntries: tree.tree.filter(entry => entry.path.startsWith(fixturePrefix)).map(({ path, sha, mode, type }) => ({ path, sha, mode, type })),
  });
  assert.equal(currentSource(), sourceSha, 'local source changed during verification');
  assert.equal(api(`${prefix}/branches/main`).commit.sha, sourceSha, 'remote main changed during verification');
  console.log(`Verified genuine POSIX server, atomic and deployment gates for ${sourceSha}: ${result.html_url}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`posix-gate: ${error.message}`); process.exitCode = 1; });
}
