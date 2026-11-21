import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import _ from 'lodash';

import NodeFireModule from '../built/index.js';

const {default: NodeFire} = NodeFireModule;
let appCounter = 0;

class FakeReference {
  constructor(
    path = '/',
    appName = `cache-test-${++appCounter}`,
    databaseName = appName,
    valueListenerAdds = new Map(),
    connectedCallbacks = [],
    databaseRoot = `https://${databaseName}.test`,
    events = {callbacks: new Map(), snapshots: new Map()}
  ) {
    this.path = path;
    this.databaseName = databaseName;
    this.databaseRoot = databaseRoot;
    this.events = events;
    this.valueListenerAdds = valueListenerAdds;
    this.connectedCallbacks = connectedCallbacks;
    this.database = {app: {name: appName}};
  }

  get key() {
    return this.path === '/' ? null : this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  get parent() {
    if (this.path === '/') return null;
    const path = this.path.slice(0, this.path.lastIndexOf('/')) || '/';
    return new FakeReference(
      path, this.database.app.name, this.databaseName,
      this.valueListenerAdds, this.connectedCallbacks, this.databaseRoot, this.events
    );
  }

  get ref() {
    return this;
  }

  get root() {
    return new FakeReference(
      '/', this.database.app.name, this.databaseName,
      this.valueListenerAdds, this.connectedCallbacks, this.databaseRoot, this.events
    );
  }

  child(childPath) {
    const path = this.path === '/' ? `/${childPath}` : `${this.path}/${childPath}`;
    return new FakeReference(
      path, this.database.app.name, this.databaseName,
      this.valueListenerAdds, this.connectedCallbacks, this.databaseRoot, this.events
    );
  }

  isEqual(other) {
    return (
      this.database.app.name === other.database.app.name &&
      this.databaseName === other.databaseName &&
      this.databaseRoot === other.databaseRoot &&
      this.path === other.path
    );
  }

  off(event, callback) {
    if (event === 'value') this.events.callbacks.get(this.path)?.delete(callback);
  }

  on(event, callback, cancel) {
    // eslint-disable-next-line lodash/prefer-lodash-method
    if (event === 'value' && !this.path.startsWith('/.info/')) {
      this.valueListenerAdds.set(this.path, (this.valueListenerAdds.get(this.path) || 0) + 1);
      const callbacks = this.events.callbacks.get(this.path) || new Map();
      callbacks.set(callback, cancel);
      this.events.callbacks.set(this.path, callbacks);
      if (this.events.snapshots.has(this.path)) callback(this.events.snapshots.get(this.path));
    }
    if (this.path === '/.info/serverTimeOffset') {
      // eslint-disable-next-line lodash/prefer-constant
      callback({val: () => 0});
    }
    if (this.path === '/.info/connected') {
      this.connectedCallbacks.push(callback);
      // eslint-disable-next-line lodash/prefer-constant
      callback({val: () => true});
    }
  }

  once(event, callback) {
    const snap = this.events.snapshots.get(this.path);
    callback?.(snap);
    this.events.afterOnce?.();
    return Promise.resolve(snap);
  }

  emit(path, snap) {
    this.events.snapshots.set(path, snap);
    for (const callback of this.events.callbacks.get(path)?.keys() ?? []) callback(snap);
  }

  emitConnected(value) {
    for (const callback of this.connectedCallbacks) callback({val: () => value});
  }

  toString() {
    return this.databaseRoot + this.path;
  }

  transaction(update, complete) {
    const result = update(this.events.snapshots.get(this.path).val());
    complete(null, result !== undefined, {val: () => result});
    return Promise.resolve();
  }
}

function snapshot(value) {
  return {val: () => _.cloneDeep(value)};
}

function getSizeStats() {
  const {estimatedViewBytes, freshSizePct, pendingSizeCount} = NodeFire.getCacheStats();
  return {estimatedViewBytes, freshSizePct, pendingSizeCount};
}

afterEach(() => {
  NodeFire.setCacheSize(0);
  NodeFire.resetCacheStats();
});

test('counts a cached ancestor as a cache hit', () => {
  NodeFire.setCacheSize(10);
  const root = new NodeFire(new FakeReference());
  const descendant = root.childRaw('parent/child/grandchild');

  root.childRaw('parent').cache();
  descendant.cache();

  assert.deepEqual(NodeFire.getCacheStats(), {
    count: 2,
    maxSize: 10,
    hits: 1,
    misses: 1,
    hitRate: 0.5,
    estimatedViewBytes: 0,
    freshSizePct: null,
    pendingSizeCount: 2
  });

  assert.equal(descendant.uncache(), true);
  NodeFire.resetCacheStats();
  assert.deepEqual(NodeFire.getCacheStats(), {
    count: 1,
    maxSize: 10,
    hits: 0,
    misses: 0,
    hitRate: 0,
    estimatedViewBytes: 0,
    freshSizePct: null,
    pendingSizeCount: 1
  });
});

test('counts the cached root as a cache hit for descendants', () => {
  NodeFire.setCacheSize(10);
  const root = new NodeFire(new FakeReference());

  assert.equal(root.path, '/');
  root.cache();
  root.childRaw('child/grandchild').cache();

  assert.deepEqual(NodeFire.getCacheStats(), {
    count: 2,
    maxSize: 10,
    hits: 1,
    misses: 1,
    hitRate: 0.5,
    estimatedViewBytes: 0,
    freshSizePct: null,
    pendingSizeCount: 2
  });
});

test('scopes ancestor cache hits to the database instance', () => {
  NodeFire.setCacheSize(10);
  const firstRoot = new NodeFire(new FakeReference('/', 'shared-app', 'first-database'));
  const secondRoot = new NodeFire(new FakeReference('/', 'shared-app', 'second-database'));

  firstRoot.childRaw('parent').cache();
  secondRoot.childRaw('parent/child').cache();

  assert.deepEqual(NodeFire.getCacheStats(), {
    count: 2,
    maxSize: 10,
    hits: 0,
    misses: 2,
    hitRate: 0,
    estimatedViewBytes: 0,
    freshSizePct: null,
    pendingSizeCount: 2
  });
});

test('counts unrelated paths as cache misses', () => {
  NodeFire.setCacheSize(10);
  const root = new NodeFire(new FakeReference());

  root.childRaw('one').cache();
  root.childRaw('two').cache();

  assert.deepEqual(NodeFire.getCacheStats(), {
    count: 2,
    maxSize: 10,
    hits: 0,
    misses: 2,
    hitRate: 0,
    estimatedViewBytes: 0,
    freshSizePct: null,
    pendingSizeCount: 2
  });
});

test('keeps deprecated cache methods callable without a receiver', () => {
  NodeFire.setCacheSize(10);
  const root = new NodeFire(new FakeReference());
  root.cache();
  root.cache();

  const getCacheCount = NodeFire.getCacheCount;
  const getCacheHitRate = NodeFire.getCacheHitRate;
  const resetCacheHitRate = NodeFire.resetCacheHitRate;

  assert.equal(getCacheCount(), 1);
  assert.equal(getCacheHitRate(), 0.5);
  resetCacheHitRate();
  assert.deepEqual(NodeFire.getCacheStats(), {
    count: 1,
    maxSize: 10,
    hits: 0,
    misses: 0,
    hitRate: 0,
    estimatedViewBytes: 0,
    freshSizePct: null,
    pendingSizeCount: 1
  });
});

test('counts raw Firebase data and weights freshness by bytes', async () => {
  NodeFire.setCacheSize(10);
  const reference = new FakeReference();
  const root = new NodeFire(reference);
  const first = root.childRaw('first');
  const second = root.childRaw('second');
  first.cache();
  second.cache();
  assert.deepEqual(getSizeStats(), {
    estimatedViewBytes: 0, freshSizePct: null, pendingSizeCount: 2
  });
  reference.emit('/first', snapshot(null));
  assert.deepEqual(getSizeStats(), {
    estimatedViewBytes: 0, freshSizePct: null, pendingSizeCount: 1
  });
  reference.emit('/first', snapshot({value: 'ignored until read'}));
  reference.emit('/second', snapshot(false));
  let estimates = getSizeStats();
  assert.equal(estimates.estimatedViewBytes, 48);
  assert.equal(estimates.freshSizePct, 100);

  const value = [null, false, 0, ''];
  reference.emit('/first', snapshot(value));
  assert.deepEqual(await first.get(), {1: false, 2: 0, 3: ''});
  const expectedBytes = 96 + 3 * (64 + 48) + 14.3 + 0.65 * 16;
  estimates = getSizeStats();
  assert.ok(Math.abs(estimates.estimatedViewBytes - expectedBytes - 48) < 1e-9);
  assert.equal(estimates.freshSizePct, 100);

  reference.emit('/first', {val() {assert.fail('Updates should leave the old size stale');}});
  estimates = getSizeStats();
  assert.ok(Math.abs(estimates.estimatedViewBytes - expectedBytes - 48) < 1e-9);
  assert.ok(Math.abs(estimates.freshSizePct - 4800 / (expectedBytes + 48)) < 1e-9);
});

test('measures a FireCrypt read once and preserves falsy values', async () => {
  NodeFire.setCacheSize(10);
  const reference = new FakeReference();
  const root = new NodeFire(reference);
  for (const [index, value] of [false, 0, '', null].entries()) {
    const path = `value${index}`;
    let measured = 0;
    const size = {entries: 0, containers: 0, scalars: 1, numbers: 0, stringBytes: 40};
    reference.emit('/' + path, {
      valWithSize() {measured++; return {value, size};},
      val() {return value;},
      rawSize() {assert.fail('The first size should come from get()');}
    });
    assert.equal(await root.childRaw(path).get(), value);
    assert.equal(await root.childRaw(path).get(), value);
    assert.equal(measured, 1);
  }
  await nextTurn();
  assert.equal(getSizeStats().estimatedViewBytes, 4 * (48 + 0.65 * 40));
});

test('default transaction prefetch measures the raw snapshot once', async () => {
  NodeFire.setCacheSize(10);
  const reference = new FakeReference();
  const ref = new NodeFire(reference).childRaw('value');
  let rawMeasures = 0;
  reference.emit('/value', {
    val: _.constant(2),
    rawSize() {
      rawMeasures++;
      return {entries: 0, containers: 0, scalars: 1, numbers: 0, stringBytes: 24};
    }
  });
  assert.equal(await ref.transaction(value => value + 1), 3);
  await nextTurn();
  assert.equal(rawMeasures, 1);
  assert.equal(getSizeStats().estimatedViewBytes, 48 + 0.65 * 24);
});

test('a read racing a listener update cannot make its older estimate fresh', async () => {
  NodeFire.setCacheSize(10);
  const reference = new FakeReference();
  const ref = new NodeFire(reference).childRaw('value');
  reference.emit('/value', snapshot(''));
  reference.events.afterOnce = () => reference.emit('/value', snapshot(false));
  assert.equal(await ref.get(), '');
  await nextTurn();
  assert.deepEqual(getSizeStats(), {
    estimatedViewBytes: 48 + 0.65 * 16, freshSizePct: 0, pendingSizeCount: 0
  });
  delete reference.events.afterOnce;
  assert.equal(await ref.get(), false);
  assert.deepEqual(getSizeStats(), {
    estimatedViewBytes: 48, freshSizePct: 100, pendingSizeCount: 0
  });
});

test('only measured ancestors in the same database and access scope cover descendants', () => {
  NodeFire.setCacheSize(10);
  const reference = new FakeReference();
  const otherAccess = new FakeReference('/', 'authed-app', reference.databaseName);
  const root = new NodeFire(reference);
  const otherRoot = new NodeFire(otherAccess);
  root.childRaw('parent').cache();
  root.childRaw('parent/value').cache();
  otherRoot.childRaw('parent/value').cache();
  reference.emit('/parent/value', snapshot(false));
  otherAccess.emit('/parent/value', snapshot(false));
  assert.deepEqual(getSizeStats(), {
    estimatedViewBytes: 96, freshSizePct: 100, pendingSizeCount: 1
  });
  reference.emit('/parent', snapshot({value: false}));
  const bytes = 96 + 64 + 48 + 48;
  assert.deepEqual(getSizeStats(), {
    estimatedViewBytes: bytes, freshSizePct: 100, pendingSizeCount: 0
  });
  reference.emit('/parent', snapshot({value: true}));
  assert.equal(getSizeStats().freshSizePct, 4800 / bytes);
  root.childRaw('parent').uncache();
  assert.deepEqual(getSizeStats(), {
    estimatedViewBytes: 96, freshSizePct: 100, pendingSizeCount: 0
  });
});

test('eviction, reinsertion, and disconnect ignore old value and cancel callbacks', async () => {
  NodeFire.setCacheSize(1);
  const reference = new FakeReference();
  const root = new NodeFire(reference);
  const ref = root.childRaw('value');
  ref.cache();
  const [[oldValue, oldCancel]] = reference.events.callbacks.get('/value');
  const oldSnap = {val() {assert.fail('An evicted listener tried to read the old snapshot');}};
  root.childRaw('evicts').cache();
  ref.cache();
  oldValue(oldSnap);
  oldCancel();
  assert.equal(NodeFire.getCacheCount(), 1);
  const [[currentValue, currentCancel]] = reference.events.callbacks.get('/value');
  reference.emitConnected(false);
  currentValue(oldSnap);
  currentCancel();
  await nextTurn();
  assert.equal(NodeFire.getCacheCount(), 0);
  assert.deepEqual(getSizeStats(), {
    estimatedViewBytes: 0, freshSizePct: null, pendingSizeCount: 0
  });
});

test('refreshes direct hits without adding duplicate value listeners', () => {
  NodeFire.setCacheSize(2);
  const reference = new FakeReference();
  const root = new NodeFire(reference);
  const first = root.childRaw('first');
  const second = root.childRaw('second');

  first.cache();
  second.cache();
  first.cache();
  root.childRaw('third').cache();

  assert.equal(reference.valueListenerAdds.get('/first'), 1);
  assert.equal(second.uncache(), false);
  assert.equal(first.uncache(), true);
});

test('does not refresh ancestor recency while checking for indirect hits', () => {
  NodeFire.setCacheSize(2);
  const root = new NodeFire(new FakeReference());
  const ancestor = root.childRaw('parent');
  const other = root.childRaw('other');
  const descendant = root.childRaw('parent/child');

  ancestor.cache();
  other.cache();
  descendant.cache();

  assert.equal(ancestor.uncache(), false);
  assert.equal(other.uncache(), true);
  assert.equal(descendant.uncache(), true);
});

test('tracks disconnects and trims the cache per database instance', () => {
  NodeFire.setCacheSize(10);
  const firstReference = new FakeReference('/', 'disconnect-app', 'first-database');
  const secondReference = new FakeReference('/', 'disconnect-app', 'second-database');
  const first = new NodeFire(firstReference).childRaw('value');
  const second = new NodeFire(secondReference).childRaw('value');

  first.cache();
  second.cache();
  firstReference.emitConnected(false);

  assert.equal(first.uncache(), false);
  assert.equal(second.uncache(), true);

  second.cache();
  secondReference.emitConnected(false);
  assert.equal(second.uncache(), false);
});

test('does not trim a database whose identity extends another database identity', () => {
  NodeFire.setCacheSize(10);
  const firstReference = new FakeReference(
    '/', 'prefix-app', 'first-database', new Map(), [],
    'https://emulator.test/?ns=foo'
  );
  const secondReference = new FakeReference(
    '/', 'prefix-app', 'second-database', new Map(), [],
    'https://emulator.test/?ns=foobar'
  );
  const first = new NodeFire(firstReference).childRaw('value');
  const second = new NodeFire(secondReference).childRaw('value');

  first.cache();
  second.cache();
  firstReference.emitConnected(false);

  assert.equal(first.uncache(), false);
  assert.equal(second.uncache(), true);
});
