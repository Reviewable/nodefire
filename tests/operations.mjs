import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {test} from 'node:test';
import {setImmediate, setTimeout} from 'node:timers';

import _ from 'lodash';

const require = createRequire(import.meta.url);
const FirefightModule = require('firefight');
let permissionDiagnostic = Promise.resolve('permission trace');
let permissionDiagnosticStartTime;
FirefightModule.Simulator = class {
  isPermissionDenied(error) {
    return error.code === 'PERMISSION_DENIED';
  }

  auth() {
    permissionDiagnosticStartTime = performance.now();
    return {set: () => permissionDiagnostic};
  }
};
const {default: NodeFire} = require('../built/index.js');
let appCounter = 0;
let beforeInterceptor = _.noop;
let afterInterceptor = _.noop;
let laterAfterInterceptor = _.noop;

NodeFire.interceptOperations((...args) => beforeInterceptor(...args));
NodeFire.interceptOperations((...args) => afterInterceptor(...args), 'after');
NodeFire.interceptOperations((...args) => laterAfterInterceptor(...args), 'after');

function resetInterceptors() {
  beforeInterceptor = _.noop;
  afterInterceptor = _.noop;
  laterAfterInterceptor = _.noop;
}

class FakeReference {
  constructor(path = '/', operations = {}, database = {
    app: {name: `operations-test-${++appCounter}`, options: {}}
  }) {
    this.path = path;
    this.operations = operations;
    this.database = database;
  }

  get key() {
    return this.path === '/' ? null : this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  get ref() {
    return this;
  }

  get root() {
    return new FakeReference('/', this.operations, this.database);
  }

  child(path) {
    return new FakeReference(
      `${this.path === '/' ? '' : this.path}/${path}`, this.operations, this.database);
  }

  isEqual(other) {
    return this.database === other.database && this.path === other.path;
  }

  on(event, callback) {
    if (_.endsWith(this.path, '/.info/serverTimeOffset')) callback({val: _.constant(0)});
    if (_.endsWith(this.path, '/.info/connected')) callback({val: _.constant(true)});
  }

  off() {/* Nothing to detach in the fake reference. */}

  set(value) {
    return this.operations.set?.(value) ?? Promise.resolve();
  }

  transaction(updateFunction, callback) {
    return this.operations.transaction?.(updateFunction, callback) ?? Promise.resolve();
  }

  toString() {
    return `https://operations.test${this.path}`;
  }
}

test('before and after interceptors share the descriptor and wait for promises', async t => {
  t.after(resetInterceptors);
  let resolveAfter;
  const afterReady = new Promise(resolve => {resolveAfter = resolve;});
  let beforeDescriptor;
  let afterDescriptor;
  beforeInterceptor = (op, options) => {
    beforeDescriptor = op;
    options.fromBefore = true;
  };
  afterInterceptor = async (op, options) => {
    afterDescriptor = op;
    assert.strictEqual(options.fromBefore, true);
    await afterReady;
  };

  const ref = new NodeFire(new FakeReference('/writes'));
  let settled = false;
  const promise = ref.set('value').then(() => {settled = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(settled, false);
  assert.strictEqual(afterDescriptor, beforeDescriptor);
  assert.strictEqual(afterDescriptor.method, 'set');
  assert.deepStrictEqual(afterDescriptor.args, ['value']);
  assert.strictEqual(afterDescriptor.error, undefined);
  assert.ok(afterDescriptor.duration >= 0);
  assert.ok(afterDescriptor.startTime <= performance.now());
  resolveAfter();
  await promise;
});

test('after interceptors observe operation errors without replacing them', async t => {
  t.after(resetInterceptors);
  const operationError = new Error('write failed');
  let observedError;
  afterInterceptor = op => {
    observedError = op.error;
    throw new Error('observer failed');
  };

  const ref = new NodeFire(new FakeReference('/writes', {
    set: () => Promise.reject(operationError)
  }));
  await assert.rejects(ref.set('value'), error => {
    assert.strictEqual(error, operationError);
    assert.strictEqual(error.cause?.message, 'observer failed');
    return true;
  });
  assert.strictEqual(observedError, operationError);
});

test('after interceptor failures wait for later interceptors before propagating', async t => {
  t.after(resetInterceptors);
  const interceptorError = new Error('observer failed');
  let laterCalled = false;
  let resolveLater;
  const laterReady = new Promise(resolve => {resolveLater = resolve;});
  afterInterceptor = () => {throw interceptorError;};
  laterAfterInterceptor = () => {
    laterCalled = true;
    return laterReady;
  };

  const ref = new NodeFire(new FakeReference('/writes'));
  let settled = false;
  let rejection;
  const promise = ref.set('value');
  const observedPromise = promise.then(
    () => {settled = true;},
    error => {
      settled = true;
      rejection = error;
    }
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(laterCalled, true);
  assert.strictEqual(settled, false);
  resolveLater();
  await observedPromise;
  assert.strictEqual(rejection, interceptorError);
});

test('permission diagnostics do not add to operation duration', async t => {
  t.after(resetInterceptors);
  let resolveDiagnostic;
  permissionDiagnostic = new Promise(resolve => {resolveDiagnostic = resolve;});
  t.after(() => {permissionDiagnostic = Promise.resolve('permission trace');});
  const database = {
    app: {
      name: `operations-test-${++appCounter}`,
      options: {databaseAuthVariableOverride: {uid: 'test'}}
    },
    ref: _.constant({toString: _.constant('https://operations-test.firebaseio.com/')})
  };
  const permissionError = _.assign(new Error('permission_denied'), {
    code: 'PERMISSION_DENIED'
  });
  const ref = new NodeFire(new FakeReference('/writes', {
    set: () => Promise.reject(permissionError)
  }, database));
  ref.enablePermissionDebugging('secret');
  t.after(() => ref.enablePermissionDebugging(null));
  let descriptor;
  afterInterceptor = op => {descriptor = op;};

  let settled = false;
  const promise = ref.set('value');
  promise.then(() => {settled = true;}, () => {settled = true;});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.strictEqual(settled, false);
  resolveDiagnostic('permission trace');
  await assert.rejects(promise, error => error === permissionError);
  assert.strictEqual(descriptor.error.firebase.permissionTrace, 'permission trace');
  assert.ok(descriptor.startTime + descriptor.duration <= permissionDiagnosticStartTime + 5);
});

test('transaction duration is averaged across tries', async t => {
  t.after(resetInterceptors);
  let descriptor;
  afterInterceptor = op => {descriptor = op;};

  const ref = new NodeFire(new FakeReference('/writes', {
    transaction: (updateFunction, callback) => {
      updateFunction(null);
      setTimeout(() => {
        updateFunction(null);
        callback(null, true, {val: _.constant('committed')});
      }, 30);
      return Promise.resolve();
    }
  }));
  const result = await ref.transaction(_.constant('committed'), {prefetchValue: false});
  assert.strictEqual(result, 'committed');
  assert.strictEqual(descriptor.transaction.outcome, 'commit');
  assert.strictEqual(descriptor.transaction.tries, 2);
  assert.ok(descriptor.duration >= 10);
  assert.ok(descriptor.duration < 30);
});

test('transactions blocked by before interceptors do not invoke after interceptors', async t => {
  t.after(resetInterceptors);
  const interceptorError = new Error('blocked');
  let operationCalled = false;
  let afterCalled = false;
  beforeInterceptor = () => Promise.reject(interceptorError);
  afterInterceptor = () => {afterCalled = true;};

  const ref = new NodeFire(new FakeReference('/writes', {
    transaction: () => {
      operationCalled = true;
      return Promise.resolve();
    }
  }));
  await assert.rejects(
    ref.transaction(_.constant('committed'), {prefetchValue: false}),
    error => error === interceptorError
  );
  assert.strictEqual(operationCalled, false);
  assert.strictEqual(afterCalled, false);
});
