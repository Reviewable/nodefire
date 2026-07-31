import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';

import NodeFireModule from '../built/index.js';

const {default: NodeFire} = NodeFireModule;
let appCounter = 0;

class FakeReference {
  constructor(path = '/', appName = `cache-test-${++appCounter}`) {
    this.path = path;
    this.database = {app: {name: appName}};
  }

  get key() {
    return this.path === '/' ? null : this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  get parent() {
    if (this.path === '/') return null;
    const path = this.path.slice(0, this.path.lastIndexOf('/')) || '/';
    return new FakeReference(path, this.database.app.name);
  }

  get ref() {
    return this;
  }

  get root() {
    return new FakeReference('/', this.database.app.name);
  }

  child(childPath) {
    const path = this.path === '/' ? `/${childPath}` : `${this.path}/${childPath}`;
    return new FakeReference(path, this.database.app.name);
  }

  isEqual(other) {
    return this.database.app.name === other.database.app.name && this.path === other.path;
  }

  off() {/* Nothing to detach in the fake reference. */}

  on(event, callback) {
    if (this.path === '/.info/serverTimeOffset') {
      // eslint-disable-next-line lodash/prefer-constant
      callback({val: () => 0});
    }
    if (this.path === '/.info/connected') {
      // eslint-disable-next-line lodash/prefer-constant
      callback({val: () => true});
    }
  }

  toString() {
    return `https://${this.database.app.name}.test${this.path}`;
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

  root.childRaw('parent').cache();
  root.childRaw('parent/child/grandchild').cache();

  assert.deepEqual(NodeFire.getCacheStats(), {
    count: 1,
    maxSize: 10,
    hits: 1,
    misses: 1,
    hitRate: 0.5
  });

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
    count: 1,
    maxSize: 10,
    hits: 1,
    misses: 1,
    hitRate: 0.5
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
