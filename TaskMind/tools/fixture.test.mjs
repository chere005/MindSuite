import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./php-runtime.mjs', () => ({ php: 'php', phpArgs: [] }));
import { siteLib } from './fixture.mjs';

describe('fixture account-library discovery', () => {
  let scratch;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'taskmind-fixture-path-'));
    vi.stubEnv('TASKMIND_TEST_SITE_LIB', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  });
  function accountLibrary(parent) {
    const lib = path.join(parent, 'seancheren-site', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(path.join(lib, 'auth.php'), '<?php');
    return lib;
  }

  it('finds the site beside a standalone TaskMind checkout', () => {
    const lib = accountLibrary(scratch);
    expect(siteLib(path.join(scratch, 'TaskMind'))).toBe(lib);
  });

  it('finds the site beside the containing MindSuite checkout', () => {
    const lib = accountLibrary(scratch);
    expect(siteLib(path.join(scratch, 'MindSuite', 'TaskMind'))).toBe(lib);
  });

  it('prefers the nearest valid site when both layouts exist', () => {
    accountLibrary(scratch);
    const nearest = accountLibrary(path.join(scratch, 'MindSuite'));
    expect(siteLib(path.join(scratch, 'MindSuite', 'TaskMind'))).toBe(nearest);
  });

  it('ignores a nearer directory that has no account library', () => {
    const lib = accountLibrary(scratch);
    mkdirSync(path.join(scratch, 'MindSuite', 'seancheren-site', 'lib'), { recursive: true });
    expect(siteLib(path.join(scratch, 'MindSuite', 'TaskMind'))).toBe(lib);
  });

  it('preserves the explicit environment override without replacing it', () => {
    accountLibrary(scratch);
    const explicit = path.join(scratch, 'chosen-site-library');
    vi.stubEnv('TASKMIND_TEST_SITE_LIB', explicit);
    expect(siteLib(path.join(scratch, 'TaskMind'))).toBe(explicit);
    expect(siteLib(path.join(scratch, 'MindSuite', 'TaskMind'))).toBe(explicit);
  });

  it('keeps the standalone fallback when no local site is available', () => {
    const checkout = path.join(scratch, 'TaskMind');
    expect(siteLib(checkout)).toBe(path.join(scratch, 'seancheren-site', 'lib'));
  });
});
