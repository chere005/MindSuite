import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gateName, makeWorkflow, repository, requiredSteps, validateGate, workflowPath } from './posix-gate.mjs';

const sourceSha = 'a'.repeat(40), gateSha = 'b'.repeat(40);
const manifestText = JSON.stringify({ schema: 1, repository: 'chere005/seancheren-site', commit: 'c'.repeat(40), files: [{ name: 'auth.php', sha: 'd'.repeat(40) }] }, null, 2) + '\n';
const hash = (algorithm, text) => createHash(algorithm).update(text).digest('hex');
function good() {
  return {
    run: { repository: { full_name: repository }, head_repository: { full_name: repository }, workflow_id: 10, path: workflowPath,
      event: 'workflow_dispatch', triggering_actor: { login: 'github-actions[bot]' }, head_branch: `preflight/planmind-posix/${sourceSha.slice(0, 12)}`,
      head_sha: gateSha, status: 'completed', conclusion: 'success' },
    workflow: { id: 10, path: workflowPath }, sourceParent: sourceSha, branchSha: gateSha, mainSha: sourceSha,
    workflowText: makeWorkflow(sourceSha, hash('sha256', manifestText)),
    fixtureEntries: [
      { path: '.github/planmind-posix/manifest.json', sha: hash('sha1', `blob ${Buffer.byteLength(manifestText)}\0${manifestText}`), mode: '100644', type: 'blob' },
      { path: '.github/planmind-posix/site-lib/auth.php', sha: 'd'.repeat(40), mode: '100644', type: 'blob' },
    ],
    jobs: [{ name: gateName, head_sha: gateSha, status: 'completed', conclusion: 'success', steps: requiredSteps.map(name => ({ name, status: 'completed', conclusion: 'success' })) }],
  };
}
const verify = value => validateGate({ sourceSha, manifestText }, value);
test('accepts exact source, workflow, tracked fixture and successful real gate steps', () => verify(good()));
const attacks = {
  'another repository': value => { value.run.repository.full_name = 'elsewhere/repo'; },
  'another workflow': value => { value.workflow.id = 11; },
  'human handoff instead of bot tests': value => { value.run.triggering_actor.login = 'owner'; },
  'changed source parent': value => { value.sourceParent = 'e'.repeat(40); },
  'changed remote main': value => { value.mainSha = 'e'.repeat(40); },
  'moved preflight branch': value => { value.branchSha = 'e'.repeat(40); },
  'unfinished run': value => { value.run.status = 'in_progress'; },
  'altered gate definition': value => { value.workflowText = value.workflowText.replace('npm run test:server', 'true'); },
  'altered fixture library': value => { value.fixtureEntries[1].sha = 'e'.repeat(40); },
  'unlisted fixture file': value => { value.fixtureEntries.push({ path: '.github/planmind-posix/site-lib/config.php', sha: 'f'.repeat(40), mode: '100644', type: 'blob' }); },
  'failed job': value => { value.jobs[0].conclusion = 'failure'; },
  'failed step hidden by continue-on-error': value => { value.jobs[0].steps.at(-1).conclusion = 'failure'; },
  'unfinished step': value => { value.jobs[0].steps.at(-1).status = 'in_progress'; },
  'skipped server check': value => { value.jobs[0].steps.find(step => step.name === 'Run server checks').conclusion = 'skipped'; },
  'missing server check': value => { value.jobs[0].steps = value.jobs[0].steps.filter(step => step.name !== 'Run server checks'); },
  'repeated gate job': value => { value.jobs.push(structuredClone(value.jobs[0])); },
};
for (const [name, change] of Object.entries(attacks)) test(`refuses ${name}`, () => { const value = good(); change(value); assert.throws(() => verify(value)); });
