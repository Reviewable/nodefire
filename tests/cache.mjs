import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';

import NodeFireModule from '../built/index.js';

const {default: NodeFire} = NodeFireModule;
let appCounter = 0;

class FakeReference {
  constructor(
    path = '/',
    appName = `cache-test-${++appCounter}`,
    databaseName = appName,
    valueListenerAdds = new Map(),
    connectedCallbacks = []
  ) {
    this.path = path;
    this.databaseName = databaseName;
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
      this.valueListenerAdds, this.connectedCallbacks
    );
  }

  get ref() {
    return this;
  }

  get root() {
    return new FakeReference(
      '/', this.database.app.name, this.databaseName,
      this.valueListenerAdds, this.connectedCallbacks
    );
  }

  child(childPath) {
    const path = this.path === '/' ? `/${childPath}` : `${this.path}/${childPath}`;
    return new FakeReference(
      path, this.database.app.name, this.databaseName,
      this.valueListenerAdds, this.connectedCallbacks
    );
  }

  isEqual(other) {
    return (
      this.database.app.name === other.database.app.name &&
      this.databaseName === other.databaseName &&
      this.path === other.path
    );
  }

  off() {/* Nothing to detach in the fake reference. */}

  on(event, callback) {
    // eslint-disable-next-line lodash/prefer-lodash-method
    if (event === 'value' && !this.path.startsWith('/.info/')) {
      this.valueListenerAdds.set(this.path, (this.valueListenerAdds.get(this.path) || 0) + 1);
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

  emitConnected(value) {
    for (const callback of this.connectedCallbacks) callback({val: () => value});
  }

  toString() {
    return `https://${this.databaseName}.test${this.path}`;
  }

  transaction() {/* The constructor only checks that this method exists. */}
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
    hitRate: 0.5
  });

  assert.equal(descendant.uncache(), true);
  NodeFire.resetCacheStats();
  assert.deepEqual(NodeFire.getCacheStats(), {
    count: 1,
    maxSize: 10,
    hits: 0,
    misses: 0,
    hitRate: 0
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
    hitRate: 0.5
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
    hitRate: 0
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
    hitRate: 0
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
    hitRate: 0
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
