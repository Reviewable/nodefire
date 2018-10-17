'use strict';

const admin = require('firebase-admin');
const _ = require('lodash');
const LRUCache = require('lru-cache');
const firebaseChildrenKeys = require('firebase-childrenkeys');
const firefight = require('firefight');

let cache, cacheHits = 0, cacheMisses = 0, maxCacheSizeForDisconnectedApp = Infinity;
const serverTimeOffsets = {}, serverDisconnects = {}, simulators = {};
const operationInterceptors = [];


/**
 * A wrapper around a Firebase Admin reference, and the main entry point to the module.  You can
 * pretty much use this class as you would use the Firebase class.  The major difference is that
 * each NodeFire object has a scope dictionary associated with it that's used to interpolate any
 * path used in a call.
 *
 * Every method that returns a promise also accepts an options object as the last argument.  One
 * standard option is `timeout`, which will cause an operation to time out after the given number of
 * milliseconds.  Other operation-specific options are described in their respective doc comments.
 */
// jshint latedef:false
class NodeFire {
// jshint latedef:nofunc

  /**
   * Creates a new NodeFire wrapper around a raw Firebase Admin reference.
   *
   * @param {admin.database.Query} ref A fully authenticated Firebase Admin reference or query.
   * @param {Object} scope Optional dictionary that will be used for interpolating paths.
   */
  constructor(ref, scope) {
    const refIsNonNullObject = typeof ref === 'object' && ref !== null;
    if (!refIsNonNullObject || typeof ref.ref !== 'object' ||
        typeof ref.ref.transaction !== 'function') {
      throw new Error(
        `Expected first argument passed to NodeFire constructor to be a Firebase Database reference,
        but got "${ref}".`
      );
    }

    this.$ref = ref;
    this.$scope = scope || {};
    this._path = undefined;  // initialized lazily

    trackTimeOffset(this);
    trackDisconnect(this);
  }

  /**
   * Returns a placeholder value for auto-populating the current timestamp (time since the Unix
   * epoch, in milliseconds) as determined by the Firebase servers.
   * @return {Object} A timestamp placeholder value.
   */
  static get SERVER_TIMESTAMP() {
    return {
      '.sv': 'timestamp'
    };
  }

  /**
   * Returns the database instance corresponding to this reference.
   * @return {admin.database.Database} The database instance corresponding to this reference.
   */
  get database() {
    return this.$ref.ref.database;
  }

  /**
   * Returns the last part of this reference's path. The key of a root reference is `null`.
   * @return {string|null} The last part this reference's path.
   */
  get key() {
    return this.$ref.ref.key;
  }

  /**
   * Returns just the path component of the reference's URL.
   * @return {string} The path component of the Firebase URL wrapped by this NodeFire object.
   */
  get path() {
    if (!this._path) {
      this._path =
        decodeURIComponent(this.$ref.toString()).slice(this.$ref.ref.root.toString().length - 1);
    }
    return this._path;
  }

  /**
   * Returns a NodeFire reference at the same location as this query or reference.
   * @return {NodeFire|null} A NodeFire reference at the same location as this query or reference.
   */
  get ref() {
    if (this.$ref.isEqual(this.$ref.ref)) return this;
    return new NodeFire(this.$ref.ref, this.$scope);
  }

  /**
   * Returns a NodeFire reference to the root of the database.
   * @return {NodeFire} The root reference of the database.
   */
  get root() {
    if (this.$ref.isEqual(this.$ref.ref.root)) return this;
    return new NodeFire(this.$ref.ref.root, this.$scope);
  }

  /**
   * Returns a NodeFire reference to the parent location of this reference. The parent of a root
   * reference is `null`.
   * @return {NodeFire|null} The parent location of this reference.
   */
  get parent() {
    if (this.$ref.ref.parent === null) return null;
    return new NodeFire(this.$ref.ref.parent, this.$scope);
  }

  /**
   * Interpolates variables into a template string based on the object's scope (passed into the
   * constructor, if any) and the optional scope argument.  Characters forbidden by Firebase are
   * escaped into a "\xx" hex format.
   *
   * @param  {string} string The template string to interpolate.  You can refer to scope variables
   *     using both ":varName" and "{varName}" notations, with the latter also accepting
   *     dot-separated child attributes like "{varName.child1.child2}".
   * @param  {Object} scope Optional bindings to add to the ones carried by this NodeFire object.
   *     This scope takes precedence if a key is present in both.
   * @return {string} The interpolated string
   */
  interpolate(string, scope) {
    scope = scope ? _.extend(_.clone(this.$scope), scope) : this.$scope;
    string = string.replace(/:([a-z-_]+)|\{(.+?)\}/gi, (match, v1, v2) => {
      const v = (v1 || v2);
      const parts = v.split('.');
      let value = scope;
      for (let i = 0; i < parts.length; i++) {
        value = value[parts[i]];
        if (_.isUndefined(value) || value === null) {
          throw new Error(
            'Missing or null variable "' + v + '" when expanding NodeFire path "' + string + '"');
        }
      }
      return NodeFire.escape(value);
    });
    return string;
  }

  // TODO: add onDisconnect
  // TODO: add user/password-related methods

  /**
   * Returns a JSON-serializable representation of this object.
   * @return {Object} A JSON-serializable representation of this object.
   */
  toJSON() {
    return this.$ref.toJSON();
  }

  /**
   * Returns whether or not this NodeFire instance is equivalent to the provided NodeFire instance.
   * @return {NodeFire} Another NodeFire instance against which to compare.
   */
  isEqual(otherRef) {
    return this.$ref.isEqual(otherRef.$ref);
  }

  /**
   * Stringifies the wrapped reference.
   * @return {string} The Firebase URL wrapped by this NodeFire object.
   */
  toString() {
    return decodeURIComponent(this.$ref.toString());
  }

  /**
   * Creates a new NodeFire object on the same reference, but with an extended interpolation scope.
   * @param  {Object} scope A dictionary of interpolation variables that will be added to (and take
   *     precedence over) the one carried by this NodeFire object.
   * @return {NodeFire} A new NodeFire object with the same reference and new scope.
   */
  scope(scope) {
    return new NodeFire(this.$ref, _.extend(_.clone(this.$scope), scope));
  }

  /**
   * Creates a new NodeFire object on a child of this one, and optionally an augmented scope.
   * @param  {string} path The path to the desired child, relative to this reference.  The path will
   *     be interpolated using this object's scope and the additional scope provided.  For the
   *     syntax see the interpolate() method.
   * @param  {Object} scope Optional additional scope that will add to (and override) this object's
   *     scope.
   * @return {NodeFire} A new NodeFire object on the child reference, and with the augmented scope.
   */
  child(path, scope) {
    const child = this.scope(scope);
    return new NodeFire(this.$ref.child(child.interpolate(path)), child.$scope);
  }

  /**
   * Gets this reference's current value from Firebase, and inserts it into the cache if a
   * maxCacheSize was set and the `cache` option is not false.
   * @return {Promise} A promise that is resolved to the reference's value, or rejected with an
   *     error.  The value returned is normalized, meaning arrays are converted to objects.
   */
  get(options) {
    return invoke(
      {ref: this, method: 'get', args: []}, options,
      opts => {
        if (opts.cache === undefined || opts.cache) this.cache();
        return this.$ref.once('value').then(snap => getNormalValue(snap));
      }
    );
  }

  /**
   * Adds this reference to the cache (if maxCacheSize set) and counts a cache hit or miss.
   */
  cache() {
    if (!cache) return;
    const key = this.database.app.name + '/' + this.path;
    if (cache.has(key)) {
      cacheHits++;
    } else {
      cacheMisses++;
      cache.set(key, this);
      this.$ref.on('value', noopCallback, () => {
        if (cache) cache.del(key);
      });
    }
  }

  /**
   * Removes this reference from the cache (if maxCacheSize is set).
   * @return True if the reference was cached, false otherwise.
   */
  uncache() {
    if (!cache) return;
    const key = this.database.app.name + '/' + this.path;
    if (!cache.has(key)) return false;
    cache.del(key);
    return true;
  }

  /**
   * Sets the value at this reference.
   * @param {Object || number || string || boolean} value The value to set.
   * @returns {Promise} A promise that is resolved when the value has been set, or rejected with an
   *     error.
   */
  set(value, options) {
    return invoke(
      {ref: this, method: 'set', args: [value]}, options,
      opts => this.$ref.set(value)
    );
  }

  /**
   * Updates a value at this reference, setting only the top-level keys supplied and leaving any
   * other ones as-is.
   * @param  {Object} value The value to update the reference with.
   * @return {Promise} A promise that is resolved when the value has been updated, or rejected with
   *     an error.
   */
  update(value, options) {
    return invoke(
      {ref: this, method: 'update', args: [value]}, options,
      opts => this.$ref.update(value)
    );
  }

  /**
   * Removes this reference from the Firebase.
   * @return {Promise} A promise that is resolved when the value has been removed, or rejected with
   *     an error.
   */
  remove(options) {
    return invoke(
      {ref: this, method: 'remove', args: []}, options,
      opts => this.$ref.remove()
    );
  }

  /**
   * Pushes a value as a new child of this reference, with a new unique key.  Note that if you just
   * want to generate a new unique key you can call newKey() directly.
   * @param  {Object || number || string || boolean} value The value to push.
   * @return {Promise} A promise that is resolved to a new NodeFire object that refers to the newly
   *     pushed value (with the same scope as this object), or rejected with an error.
   */
  push(value, options) {
    if (value === undefined || value === null) {
      return new NodeFire(this.$ref.push(), this.$scope);
    }
    return invoke({ref: this, method: 'push', args: [value]}, options, opts => {
      const ref = this.$ref.push(value);
      return ref.then(() => new NodeFire(ref, this.$scope));
    });
  }

  /**
   * Runs a transaction at this reference.  The transaction is not applied locally first, since this
   * would be incompatible with a promise's complete-once semantics.
   *
   * There's a bug in the Firebase SDK that fails to update the local value and will cause a
   * transaction to fail repeatedly until it fails with maxretry.  If you specify the detectStuck
   * option then an error with the message 'stuck' will be thrown earlier so that you can try to
   * work around the issue.
   *
   * @param  {function(value):value} updateFunction A function that takes the current value at this
   *     reference and returns the new value to replace it with.  Return undefined to abort the
   *     transaction, and null to remove the reference.  Be prepared for this function to be called
   *     multiple times in case of contention.
   * @param  {Object} options An options objects that may include the following properties:
   *     {number} detectStuck Throw a 'stuck' exception after the update function's input value has
   *         remained unchanged this many times.  Defaults to 0 (turned off).
   *     {boolean} prefetchValue Fetch and keep pinned the value referenced by the transaction while
   *         the transaction is in progress.  Defaults to true.
   *     {number} timeout A number of milliseconds after which to time out the transaction and
   *         reject the promise with 'timeout'.
   * @return {Promise} A promise that is resolved with the (normalized) committed value if the
   *     transaction committed or with undefined if it aborted, or rejected with an error.
   */
  transaction(updateFunction, options) {
    const self = this;  // easier than using => functions or binding explicitly
    let tries = 0, result;
    const startTime = self.now;
    let prefetchDoneTime;
    const metadata = {};
    options = options || {};

    function fillMetadata(outcome) {
      if (metadata.outcome) return;
      metadata.outcome = outcome;
      metadata.tries = tries;
      if (prefetchDoneTime) {
        metadata.prefetchDuration = prefetchDoneTime - startTime;
        metadata.duration = self.now - prefetchDoneTime;
      } else {
        metadata.duration = self.now - startTime;
      }
    }

    const op = {ref: this, method: 'transaction', args: [updateFunction]};

    return Promise.all(
      _.map(
        operationInterceptors,
        interceptor => Promise.resolve(interceptor(op, options))
      )
    ).then(() => {
      const promise = new Promise((resolve, reject) => {
        const wrappedRejectNoResult = wrapReject(self, 'transaction', reject);
        let wrappedReject = wrappedRejectNoResult;
        let aborted, settled;
        const inputValues = [];
        let numConsecutiveEqualInputValues = 0;

        function wrappedUpdateFunction(value) {
          try {
            wrappedReject = wrappedRejectNoResult;
            if (aborted) return;  // transaction otherwise aborted and promise settled, just stop
            if (options.detectStuck) {
              if (inputValues.length && _.isEqual(value, _.last(inputValues))) {
                numConsecutiveEqualInputValues++;
              } else {
                numConsecutiveEqualInputValues = 0;
                inputValues.push(_.cloneDeep(value));
              }
              if (numConsecutiveEqualInputValues >= options.detectStuck) {
                const error = new Error('stuck');
                error.inputValues = inputValues;
                throw error;
              }
            }
            if (++tries > 25) throw new Error('maxretry');
            result = updateFunction(getNormalRawValue(value));
            wrappedReject = wrapReject(self, 'transaction', result, reject);
            return result;
          } catch (e) {
            // Firebase propagates exceptions thrown by the update function to the top level.  So
            // catch them here instead, reject the promise, and abort the transaction by returning
            // undefined.  The callback will then try to resolve the promise (seeing an uncommitted
            // transaction with no error) but it'll be a no-op.
            fillMetadata('error');
            wrappedReject(e);
          }
        }

        let onceTxn, timeoutId;
        function txn() {
          if (!prefetchDoneTime) prefetchDoneTime = self.now;
          try {
            self.$ref.transaction(wrappedUpdateFunction, (error, committed, snap) => {
              if (error && (error.message === 'set' || error.message === 'disconnect')) {
                txn();
                return;
              }
              settled = true;
              if (timeoutId) clearTimeout(timeoutId);
              if (onceTxn) self.$ref.off('value', onceTxn);
              fillMetadata(error ? 'error' : (committed ? 'commit' : 'skip'));
              if (NodeFire.LOG_TRANSACTIONS) {
                console.log(JSON.stringify({txn: {
                  tries, path: self.toString().replace(/https:\/\/[^/]*/, ''),
                  outcome: metadata.outcome, value: result
                }}));
              }
              if (error) {
                wrappedReject(error);
              } else if (committed) {
                resolve(getNormalValue(snap));
              } else {
                resolve();
              }
            }, false).catch(noopCallback);
          } catch (e) {
            wrappedReject(e);
          }
        }
        if (options.timeout) {
          timeoutId = setTimeout(() => {
            if (settled) return;
            aborted = true;
            const e = new Error('timeout');
            e.timeout = options.timeout;
            wrappedReject(e);
          }, options.timeout);
        }
        if (options.prefetchValue || options.prefetchValue === undefined) {
          // Prefetch the data and keep it "live" during the transaction, to avoid running the
          // (potentially expensive) transaction code 2 or 3 times while waiting for authoritative
          // data from the server.  Also pull it into the cache to speed future transactions at this
          // ref.
          self.cache();
          onceTxn = _.once(txn);
          self.$ref.on('value', onceTxn, wrappedRejectNoResult);
        } else {
          txn();
        }
      });

      promise.transaction = metadata;
      return promise;
    });
  }

  /**
   * Registers a listener for an event on this reference.  Works the same as the Firebase method
   * except that the snapshot passed into the callback will be wrapped such that:
   *   1) The val() method will return a normalized method (like NodeFire.get() does).
   *   2) The ref() method will return a NodeFire reference, with the same scope as the reference
   *      on which on() was called.
   *   3) The child() method takes an optional extra scope parameter, just like NodeFire.child().
   */
  on(eventType, callback, cancelCallback, context) {
    cancelCallback = wrapReject(this, 'on', cancelCallback);
    this.$ref.on(
      eventType, captureCallback(this, eventType, callback), cancelCallback, context);
    return callback;
  }

  /**
   * Unregisters a listener.  Works the same as the Firebase method.
   */
  off(eventType, callback, context) {
    this.$ref.off(eventType, callback && popCallback(this, eventType, callback), context);
  }

  /**
   * Generates a unique string that can be used as a key in Firebase.
   * @return {string} A unique string that satisfies Firebase's key syntax constraints.
   */
  newKey() {
    return this.$ref.push().key;
  }

  /**
   * Returns the current timestamp after adjusting for the Firebase-computed server time offset.
   * @return {number} The current time in integer milliseconds since the epoch.
   */
  get now() {
    return new Date().getTime() + serverTimeOffsets[this.database.app.name];
  }

  /**
   * Fetches the keys of the current reference's children without also fetching all the contents,
   * using the Firebase REST API.
   *
   * @param {object} options An options object with the following items, all optional:
   *   - maxTries: the maximum number of times to try to fetch the keys, in case of transient errors
   *               (defaults to 1)
   *   - retryInterval: the number of milliseconds to delay between retries (defaults to 1000)
   * @return A promise that resolves to an array of key strings.
   */
  childrenKeys() {
    return this.$ref.childrenKeys ?
      this.$ref.childrenKeys(...arguments) :
      firebaseChildrenKeys(this.$ref, ...arguments);
  }

  /**
   * Turns Firebase low-level connection logging on or off.
   * @param {boolean} enable Whether to enable or disable logging.
   */
  static enableFirebaseLogging(enable) {
    admin.database.enableLogging(enable);
  }

  /**
   * Turns debugging of permission denied errors on and off for the database this ref is attached
   * to.  When turned on, permission denied errors will have an additional permissionTrace property
   * with a human-readable description of which security rules failed.  There's no performance
   * penalty to turning this on until a permission actually gets denied.
   * @param {string} legacySecret A legacy database secret, needed to access the old API that allows
   *     simulating request with debug feedback.  Pass a falsy value to turn off debugging.
   */
  enablePermissionDebugging(legacySecret) {
    if (legacySecret) {
      if (!simulators[this.database.app.name]) {
        const authOverride = this.database.app.options.databaseAuthVariableOverride;
        if (!authOverride || !authOverride.uid) {
          throw new Error(
            'You must initialize your database with a databaseAuthVariableOverride that includes ' +
            'a uid');
        }
        simulators[this.database.app.name] = new firefight.Simulator(this.database, legacySecret);
      }
    } else {
      delete simulators[this.database.app.name];
    }
  }

  /**
   * Adds an intercepting callback before all NodeFire database operations.  This callback can
   * modify the operation's options or block it while performing other work.
   * @param {Function} callback The callback to invoke before each operation.  It will be passed two
   *     arguments: an operation descriptor ({ref, method, args}) and an options object.  The
   *     descriptor is read-only but the options can be modified.  The callback can return any value
   *     (which will be ignored) or a promise, to block execution of the operation (but not other
   *     interceptors) until the promise settles.
   */
  static interceptOperations(callback) {
    operationInterceptors.push(callback);
  }

  /**
   * Sets the maximum number of values to keep pinned and updated in the cache.  The cache is not
   * used unless you set a non-zero maximum.
   * @param {number} max The maximum number of values to keep pinned in the cache.
   */
  static setCacheSize(max) {
    if (max) {
      if (cache) {
        cache.max = max;
      } else {
        cache = new LRUCache({max, dispose(key, ref) {
          ref.$ref.off('value', noopCallback);
        }});
      }
    } else {
      if (cache) cache.reset();
      cache = null;
    }
  }

  /**
   * Sets the maximum number of pinned values to retain in the cache when an app gets disconnected.
   * By default all values are retained, but if your cache size is high they'll all need to be
   * double-checked against the Firebase server when the connection comes back.  It may thus be more
   * economical to drop the least used ones when disconnected.
   * @param {number} max The maximum number of values from a disconnected app to keep pinned in the
   *        cache.
   */
  static setCacheSizeForDisconnectedApp(max) {
    maxCacheSizeForDisconnectedApp = max;
  }

  /**
   * Gets the current number of values pinned in the cache.
   * @return {number} The current size of the cache.
   */
  static getCacheCount() {
    return cache ? cache.itemCount : 0;
  }

  /**
   * Gets the current cache hit rate.  This is very approximate, as it's only counted for get() and
   * transaction() calls, and is unable to count ancestor hits, where the ancestor of the requested
   * item is actually cached.
   * @return {number} The cache's current hit rate.
   */
  static getCacheHitRate() {
    return (cacheHits || cacheMisses) ? cacheHits / (cacheHits + cacheMisses) : 0;
  }

  /**
   * Resets the cache's hit rate counters back to zero.
   */
  static resetCacheHitRate() {
    cacheHits = cacheMisses = 0;
  }

  /**
   * Escapes a string to make it an acceptable Firebase key.
   * @param {string} key The proposed key to escape.
   * @return {string} The escaped key.
   */
  static escape(key) {
    return key.toString().replace(/[\\.$#[\]/]/g, char => {
      return '\\' + char.charCodeAt(0).toString(16);
    });
  }

  /**
   * Unescapes a previously escaped (or interpolated) key.
   * @param {string} key The key to unescape.
   * @return {string} The original unescaped key.
   */
  static unescape(key) {
    return key.toString().replace(/\\[0-9a-f]{2}/gi, code => {
      return String.fromCharCode(parseInt(code.slice(1), 16));
    });
  }

}

/**
 * Flag that indicates whether to log transactions and the number of tries needed.
 * @type {boolean} True to log metadata about every transaction.
 */
NodeFire.LOG_TRANSACTIONS = false;

/* Query methods, same as on Firebase objects. */
wrapNodeFire('limitToFirst');
wrapNodeFire('limitToLast');
wrapNodeFire('startAt');
wrapNodeFire('endAt');
wrapNodeFire('equalTo');
wrapNodeFire('orderByChild');
wrapNodeFire('orderByKey');
wrapNodeFire('orderByValue');


/**
  A wrapper around a Firebase DataSnapshot.  Works just like a Firebase snapshot, except that
  ref returns a NodeFire instance, val() normalizes the value, and child() takes an optional
  refining scope.
 */
class Snapshot {
  constructor(snap, nodeFire) {
    this.$snap = snap;
    this.$nodeFire = nodeFire;
  }

  get key() {
    return this.$snap.key;
  }

  get ref() {
    return new NodeFire(this.$snap.ref, this.$nodeFire.$scope);
  }

  val() {
    return getNormalValue(this.$snap);
  }

  child(path, scope) {
    const childNodeFire = this.$nodeFire.scope(scope);
    return new Snapshot(this.$snap.child(childNodeFire.interpolate(path)), childNodeFire);
  }

  forEach(callback) {
    this.$snap.forEach(child => {
      return callback(new Snapshot(child, this.$nodeFire));
    });
  }
}

/* Snapshot methods that work the same. */
delegateSnapshot('toJSON');
delegateSnapshot('exists');
delegateSnapshot('hasChild');
delegateSnapshot('hasChildren');
delegateSnapshot('numChildren');


// We need to wrap the user's callback so that we can wrap each snapshot, but must keep track of the
// wrapper function in case the user calls off().  We don't reuse wrappers so that the number of
// wrappers is equal to the number of on()s for that callback, and we can safely pop one with each
// call to off().
function captureCallback(nodeFire, eventType, callback) {
  const key = eventType + '::' + nodeFire.toString();
  callback.$nodeFireCallbacks = callback.$nodeFireCallbacks || {};
  callback.$nodeFireCallbacks[key] = callback.$nodeFireCallbacks[key] || [];
  const nodeFireCallback = function(snap, previousChildKey) {
    // eslint-disable-next-line no-invalid-this
    runGenerator(callback.call(this, new Snapshot(snap, nodeFire), previousChildKey));
  };
  callback.$nodeFireCallbacks[key].push(nodeFireCallback);
  return nodeFireCallback;
}

function popCallback(nodeFire, eventType, callback) {
  const key = eventType + '::' + nodeFire.toString();
  return callback.$nodeFireCallbacks[key].pop();
}

function runGenerator(o) {
  let promise;
  if (o instanceof Promise) {
    promise = o;
  } else if (o && typeof o.next === 'function' && typeof o.throw === 'function' && Promise.co) {
    promise = Promise.co(o);
  }
  if (promise) promise.catch(error => {throw error;});
}


function wrapNodeFire(method) {
  NodeFire.prototype[method] = function() {
    return new NodeFire(
      this.$ref[method].apply(this.$ref, arguments), this.$scope);
  };
}


function delegateSnapshot(method) {
  Snapshot.prototype[method] = function() {
    return this.$snap[method].apply(this.$snap, arguments);
  };
}

function wrapReject(nodefire, method, value, reject) {
  let hasValue = true;
  if (!reject) {
    reject = value;
    hasValue = false;
  }
  if (!reject) return reject;
  return function(error) {
    handleError(error, {ref: nodefire, method, args: hasValue ? [value] : []}, reject);
  };
}

function noopCallback() {/* empty */}

function trackTimeOffset(ref, recover) {
  const appName = ref.database.app.name;
  if (!recover) {
    if (appName in serverTimeOffsets) return;
    serverTimeOffsets[appName] = 0;
  }
  ref.root.child('.info/serverTimeOffset').on('value', snap => {
    serverTimeOffsets[appName] = snap.val();
  }, _.bind(trackTimeOffset, ref, true));
}

function trackDisconnect(ref, recover) {
  const appName = ref.database.app.name;
  if (!recover && serverDisconnects[appName]) return;
  serverDisconnects[appName] = true;
  ref.root.child('.info/connected').on('value', snap => {
    if (!snap.val()) trimCache(ref);
  }, _.bind(trackDisconnect, ref, true));
}

function trimCache(ref) {
  if (!cache || cache.max <= maxCacheSizeForDisconnectedApp) return;
  const prefix = ref.database.app.name + '/';
  let count = 0;
  cache.forEach((value, key) => {
    if (key.slice(0, prefix.length) !== prefix) return;
    if (++count <= maxCacheSizeForDisconnectedApp) return;
    cache.del(key);
  });
}

function getNormalValue(snap) {
  return getNormalRawValue(snap.val());
}

function getNormalRawValue(value) {
  if (_.isArray(value)) {
    const normalValue = {};
    _.forEach(value, (item, key) => {
      if (!(item === null || _.isUndefined(item))) {
        normalValue[key] = getNormalRawValue(item);
      }
    });
    value = normalValue;
  } else if (_.isObject(value)) {
    _.forEach(value, (item, key) => {
      value[key] = getNormalRawValue(item);
    });
  }
  return value;
}

function invoke(op, options = {}, fn) {
  return Promise.all(
    _.map(
      operationInterceptors,
      interceptor => Promise.resolve(interceptor(op, options))
    )
  ).then(() => {
    const promises = [];
    let timeoutId, settled;
    if (options.timeout) {
      promises.push(new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          if (!settled) reject(new Error('timeout'));
        }, options.timeout);
      }));
    }
    promises.push(Promise.resolve(fn(options)).then(result => {
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      return result;
    }));
    return Promise.race(promises).catch(e => {
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (e.message === 'timeout') e.timeout = options.timeout;
      return handleError(e, op, Promise.reject);
    });
  });
}

function handleError(error, op, callback) {
  error.firebase = {
    ref: op.ref.toString(), method: op.method,
    code: (error.code || error.message || '').toLowerCase() || undefined,
    args: _.map(
      op.args, arg => _.isFunction(arg) ? `<function${arg.name ? ' ' + arg.name : ''}>` : arg)
  };
  if (error.message === 'timeout' && error.timeout) {
    error.firebase.timeout = error.timeout;
    delete error.timeout;
  }
  if (error.message === 'stuck' && error.inputValues) {
    error.firebase.inputValues = error.inputValues;
    delete error.inputValues;
  }
  if (!error.code) error.code = error.message;
  error.message = 'Firebase: ' + error.message;
  const simulator = simulators[op.ref.database.app.name];
  if (!simulator || !simulator.isPermissionDenied(error)) return callback(error);
  const method = op.method === 'get' ? 'once' : op.method;
  const authOverride = op.ref.database.app.options.databaseAuthVariableOverride;
  return simulator.auth(authOverride)[method](op.ref, op.args[0]).then(explanation => {
    error.firebase.permissionTrace = explanation;
    return callback(error);
  });
}

module.exports = NodeFire;
