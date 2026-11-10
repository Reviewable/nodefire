import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import process from 'node:process';
import {test} from 'node:test';

const require = createRequire(import.meta.url);
const {deleteApp, initializeApp} = require('firebase-admin/app');
const {getDatabase} = require('firebase-admin/database');
const {default: NodeFire} = require('../built/index.js');
const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST;

function waitForValue(ref, matches) {
  return new Promise((resolve, reject) => {
    const callback = snap => {
      const value = snap.val();
      if (!matches(value)) return;
      ref.off('value', callback);
      resolve(value);
    };
    ref.on('value', callback, reject);
  });
}

test('Firebase applies disconnect writes once and preserves cancelled data', {
  skip: emulator ? false : 'Set FIREBASE_DATABASE_EMULATOR_HOST to run',
  timeout: 20000
}, async t => {
  const id = randomUUID();
  const config = {
    projectId: 'demo-nodefire', databaseURL: 'https://demo-nodefire.firebaseio.com'
  };
  const writer = initializeApp(config, `writer-${id}`);
  const reader = initializeApp(config, `reader-${id}`);
  const database = getDatabase(writer);
  const path = `nodefire-tests/${id}`;
  const ref = new NodeFire(database.ref(path));
  const observed = getDatabase(reader).ref(path);
  t.after(async () => {
    try {
      database.goOffline();
      await new NodeFire(observed).remove({timeout: 3000});
    } finally {
      await Promise.all([deleteApp(writer), deleteApp(reader)]);
    }
  });

  const initial = {
    replacement: {before: true},
    status: {online: true, keep: true},
    connections: {[NodeFire.escape('instance.1')]: true, keep: {child: true}}
  };
  await ref.set(initial);
  const replacement = ref.child('replacement').onDisconnect();
  await replacement.set({first: true});
  await ref.child('status').onDisconnect().update({online: false, 'details/changed': true});
  await ref.child('connections/:id', {id: 'instance.1'}).orderByKey().limitToFirst(1)
    .onDisconnect().remove();
  await ref.child('connections/keep/child').onDisconnect().remove();
  await ref.child('connections/keep').onDisconnect().cancel();
  assert.deepEqual((await observed.get()).val(), initial);

  const firstDisconnect = waitForValue(observed, value => value?.replacement?.first);
  database.goOffline();
  assert.deepEqual(await firstDisconnect, {
    replacement: {first: true},
    status: {online: false, keep: true, details: {changed: true}},
    connections: {keep: {child: true}}
  });

  database.goOnline();
  await ref.set(initial);
  await ref.child('marker').onDisconnect().set('second');
  const secondDisconnect = waitForValue(observed, value => value?.marker === 'second');
  database.goOffline();
  assert.deepEqual(await secondDisconnect, {...initial, marker: 'second'});

  database.goOnline();
  await replacement.set({third: true});
  const thirdDisconnect = waitForValue(observed, value => value?.replacement?.third);
  database.goOffline();
  assert.deepEqual(await thirdDisconnect, {
    ...initial, replacement: {third: true}, marker: 'second'
  });
});
