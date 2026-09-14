'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('actual Azure CLI transmits file-backed JSON unchanged', {
  skip: process.env.RUN_AZURE_CLI_TRANSPORT_TEST !== '1',
  timeout: 60000,
}, async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, body, type: req.headers['content-type'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const helper = path.resolve(__dirname, '../scripts/helpers/manager-app-role-bootstrap.ps1');
  const script = `
$ErrorActionPreference = 'Stop'
. '${helper.replaceAll("'", "''")}'
$json = '{"appRoles":[{"description":"Spaces & \\"quotes\\"","isEnabled":true,"allowedMemberTypes":["User"]}]}'
$invoke = {
  param([string[]]$Arguments)
  $output = & az @Arguments --skip-authorization-header 2>&1
  @{ ExitCode = $LASTEXITCODE; Output = ($output -join [Environment]::NewLine) }
}
foreach ($method in @('PATCH', 'POST')) {
  Invoke-AzureCliJsonWrite -Method $method -Uri 'http://127.0.0.1:${server.address().port}/capture' -Json $json -CommandInvoker $invoke
}`;
  let child;
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn('pwsh', ['-NoProfile', '-Command', script], { windowsHide: true });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(received.map(r => r.method), ['PATCH', 'POST']);
    for (const request of received) {
      assert.match(request.type, /application\/json/);
      assert.deepEqual(JSON.parse(request.body), {
        appRoles: [{ description: 'Spaces & "quotes"', isEnabled: true, allowedMemberTypes: ['User'] }],
      });
    }
  } finally {
    if (child && child.exitCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
