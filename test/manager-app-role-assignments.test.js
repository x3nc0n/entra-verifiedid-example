'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('manager app-role assignment planning and safety tests pass', () => {
  const testScript = path.join(
    __dirname,
    'manager-app-role-assignments.tests.ps1'
  );
  const result = spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-File', testScript],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );

  assert.equal(
    result.status,
    0,
    `PowerShell tests failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  assert.match(result.stdout, /Manager app-role assignment tests passed/);
});
