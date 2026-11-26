import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/firefox/background.mjs', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function groupNewTab('), source.indexOf('\nasync function command('));
const make = (browser) => new Function('browser', `${body}; return groupNewTab;`)(browser);

test('groups only owned tabs, per window, and rejects modified groups', async () => {
  const groups = new Map(), members = new Map();
  let next = 0;
  const browser = {
    tabs: {
      group: async ({ groupId, tabIds, createProperties }) => {
        const id = groupId ?? ++next;
        if (createProperties) { groups.set(id, { windowId: createProperties.windowId }); members.set(id, []); }
        members.get(id).push(...tabIds.map(id => ({ id })));
        return id;
      },
      query: async ({ groupId }) => members.get(groupId),
    },
    tabGroups: {
      get: async id => groups.get(id),
      update: async (id, props) => Object.assign(groups.get(id), props),
    },
  };
  const group = make(browser), connection = { groups: new Map(), ownedTabs: new Set([1, 2, 3, 4, 5]) };
  assert.equal(await group(connection, { id: 1, windowId: 1 }), 1);
  assert.deepEqual(groups.get(1), { windowId: 1, title: 'VABU', color: 'purple' });
  assert.equal(await group(connection, { id: 2, windowId: 1 }), 1);
  assert.equal(await group(connection, { id: 3, windowId: 2 }), 2);
  members.get(1).push({ id: 99 });
  assert.equal(await group(connection, { id: 4, windowId: 1 }), 3);
  groups.get(3).title = 'User';
  assert.equal(await group(connection, { id: 5, windowId: 1 }), 4);
});

test('missing APIs return null', async () => {
  assert.equal(await make({ tabs: {} })({ groups: new Map(), ownedTabs: new Set() }, { id: 1, windowId: 1 }), null);
});
