'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Deploy to Azure requires caller-supplied group IDs and passes them to the app', () => {
  const template = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../azuredeploy.json'), 'utf8'
  ));
  for (const [parameter, variable] of [
    ['adminGroupId', 'V2_ADMIN_GROUP_ID'],
    ['usersGroupId', 'V2_USERS_GROUP_ID'],
  ]) {
    const definition = template.parameters[parameter];
    assert.equal(definition.type, 'string');
    assert.equal(Object.hasOwn(definition, 'defaultValue'), false);
    assert.equal(definition.minLength, 36);
    assert.equal(definition.maxLength, 36);
    const app = template.resources.find((resource) =>
      resource.type === 'Microsoft.App/containerApps'
    );
    const env = app.properties.template.containers[0].env;
    assert.equal(
      env.find((entry) => entry.name === variable).value,
      `[parameters('${parameter}')]`
    );
  }
});
