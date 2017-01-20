'use strict';

const Firebase = require('firebase');
const FirebaseTokenGenerator = require('firebase-token-generator');
const _ = require('lodash');
const url = require('url');
const LRUCache = require('lru-cache');

let cache, cacheHits = 0, cacheMisses = 0, maxCacheSizeForDisconnectedHost = Infinity;
let serverTimeOffsets = {}, serverDisconnects = {};


/**
  A wrapper around a Firebase DataSnapshot.  Works just like a Firebase snapshot, except that
  ref() returns a NodeFire instance, val() normalizes the value, and child() takes an optional
  refining scope.
 */
class Snapshot {
  constructor(snap, nodeFire) {
    this.$snap = snap;
    this.$nodeFire = nodeFire;
  }

  val() {
    return getNormalValue(this.$snap);
  }

  child(path, scope) {
    const childNodeFire = this.$nodeFire.scope(scope);
    return new Snapshot(this.$snap.child(childNodeFire.interpolate(path)), childNodeFire);
  }

  forEach(callback) {
    this.$snap.forEach(function(child) {
      return callback(new Snapshot(child, this.$nodeFire));
    });
  }

  ref() {
    return new NodeFire(this.$snap.ref(), this.$nodeFire.$scope, this.$nodeFire.$host);
  }
}

/* Snapshot methods that work the same. */
delegateSnapshot('exists');
delegateSnapshot('hasChild');
delegateSnapshot('hasChildren');
delegateSnapshot('key');
delegateSnapshot('numChildren');
delegateSnapshot('getPriority');
delegateSnapshot('exportVal');


/**
 * A wrapper around a Firebase reference, and the main entry point to the module.  You can pretty
 * much use this class as you would use the Firebase class.  The two major differences are:
 * 1) Most methods return promises, which you use instead of callbacks.
 * 2) Each NodeFire object has a scope dictionary associated with it that's used to interpolate any
 *    path used in a call.
 */
// jshint latedef:false
class NodeFire {
// jshint latedef:nofunc

  /*
   * @param {string || Firebase} refOrUrl The Firebase URL (or Firebase reference instance) that
   *     this object will represent.
   * @param {Object} scope Optional dictionary that will be used for interpolating paths.
   * @param {string} host For internal use only, do not pass.
   */
  constructor(refOrUrl, scope, host) {
    if (_.isString(refOrUrl)) refOrUrl = new Firebase(refOrUrl);
    this.$firebase = refOrUrl;
    this.$scope = scope || {};
    if (!host) host = url.parse(refOrUrl.toString()).host;
    this.$host = host;
    if (!(host in serverTimeOffsets)) {
      serverTimeOffsets[host] = 0;
      trackTimeOffset(host);
    }
    if (!(host in serverDisconnects)) trackDisconnect(host);
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
   * Authenticates with Firebase, using either a secret or a custom token.
   * @param  {string} secret A secret for the Firebase referenced by this NodeFire object (copy from
   *     the Firebase dashboard).
   * @param  {Object} authObject Optional.  If provided, instead of authenticating with the secret
   *     directly (which disables all security checks), we'll generate a custom token with the auth
   *     value provided here and an expiry far in the future.
   * @return {Promise} A promise that is resolved when the authentication has completed
   *     successfully, and rejected with an error if it failed.
   */
  auth(secret, authObject) {
    let token = secret;
    if (authObject) {
      // Tokens expire 10 years from now.
      token = new FirebaseTokenGenerator(secret).createToken(
        authObject, {expires: this.now() + 315360000});
    }
    return new Promise((resolve, reject) => {
      this.$firebase.authWithCustomToken(token, (error, value) => {
        if (error) reject(error); else resolve(value);
      });
    }).catch(noopCallback);
  }

  /**
   * Unauthenticates from Firebase.
   * @return {Promise} A resolved promise (for consistency, since unauthentication is immediate).
   */
  unauth() {
    this.$firebase.unauth();
    return Promise.resolved(null);
  }

  /**
   * Stringifies the wrapped reference.
   * @return {string} The Firebase URL wrapped by this NodeFire object.
   */
  toString() {
    return decodeURIComponent(this.$firebase.toString());
  }

  /**
   * Returns just the path component of the reference's URL.
   * @return {string} The path component of the Firebase URL wrapped by this NodeFire object.
   */
  path() {
    let path = decodeURIComponent(this.$firebase.toString());
    if (this.$firebase.root) path = path.slice(this.$firebase.root().toString().length - 1);
    return path;
  }

  /**
   * Creates a new NodeFire object on the same reference, but with an extended interpolation scope.
   * @param  {Object} scope A dictionary of interpolation variables that will be added to (and take
   *     precedence over) the one carried by this NodeFire object.
   * @return {NodeFire} A new NodeFire object with the same reference and new scope.
   */
  scope(scope) {
    return new NodeFire(this.$firebase, _.extend(_.clone(this.$scope), scope), this.$host);
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
    return new NodeFire(this.$firebase.child(child.interpolate(path)), child.$scope, this.$host);
  }

  /**
   * Gets this reference's current value from Firebase, and inserts it into the cache if a
   * maxCacheSize was set.
   * @return {Promise} A promise that is resolved to the reference's value, or rejected with an
   *     error.  The value returned is normalized: arrays are converted to objects, and the value's
   *     priority (if any) is set on a ".priority" attribute if the value is an object.
   */
  get() {
    this.cache();
    return new Promise((resolve, reject) => {
      reject = wrapReject(this, 'get', reject);
      this.$firebase.once('value', snap => {
        resolve(getNormalValue(snap));
      }, reject).catch(noopCallback);
    });
  }

  /**
   * Adds this reference to the cache (if maxCacheSize set) and counts a cache hit or miss.
   */
  cache() {
    if (!cache) return;
    const url = this.toString();
    if (cache.has(url)) {
      cacheHits++;
    } else {
      cacheMisses++;
      cache.set(url, this);
      this.on('value', noopCallback, () => {
        if (cache) cache.del(url);
      });
    }
  }

  /**
   * Removes this reference from the cache (if maxCacheSize is set).
   * @return True if the reference was cached, false otherwise.
   */
  uncache() {
    if (!cache) return;
    const url = this.toString();
    if (!cache.has(url)) return false;
    cache.del(url);
    return true;
  }

  /**
   * Sets the value at this reference.  To set the priority, include a ".priority" attribute on the
   * value.
   * @param {Object || number || string || boolean} value The value to set.
   * @returns {Promise} A promise that is resolved when the value has been set, or rejected with an
   *     error.
   */
  set(value) {
    return new Promise((resolve, reject) => {
      reject = wrapReject(this, 'set', value, reject);
      this.$firebase.set(value, error => {
        if (error) reject(error); else resolve();
      }).catch(noopCallback);
    });
  }

  /**
   * Sets the priority at this reference.  Useful because you can't pass a ".priority" key to
   * update().
   * @param {string || number} priority The priority for the data at this reference.
   * @returns {Promise} A promise that is resolved when the priority has been set, or rejected with
   *     an error.
   */
  setPriority(priority) {
    return new Promise((resolve, reject) => {
      reject = wrapReject(this, 'setPriority', priority, reject);
      this.$firebase.setPriority(priority, error => {
        if (error) reject(error); else resolve();
      }).catch(noopCallback);
    });
  }

  /**
   * Updates a value at this reference, setting only the top-level keys supplied and leaving any
   * other ones as-is.
   * @param  {Object} value The value to update the reference with.
   * @return {Promise} A promise that is resolved when the value has been updated, or rejected with
   *     an error.
   */
  update(value) {
    return new Promise((resolve, reject) => {
      reject = wrapReject(this, 'update', value, reject);
      this.$firebase.update(value, error => {
        if (error) reject(error); else resolve();
      }).catch(noopCallback);
    });
  }

  /**
   * Removes this reference from the Firebase.
   * @return {Promise} A promise that is resolved when the value has been removed, or rejected with
   *     an error.
   */
  remove() {
    return new Promise((resolve, reject) => {
      reject = wrapReject(this, 'remove', reject);
      this.$firebase.remove(error => {
        if (error) reject(error); else resolve();
      }).catch(noopCallback);
    });
  }

  /**
   * Pushes a value as a new child of this reference, with a new unique key.  Note that if you just
   * want to generate a new unique key you can call generateUniqueKey() directly.
   * @param  {Object || number || string || boolean} value The value to push.
   * @return {Promise} A promise that is resolved to a new NodeFire object that refers to the newly
   *     pushed value (with the same scope as this object), or rejected with an error.
   */
  push(value) {
    return new Promise((resolve, reject) => {
      reject = wrapReject(this, 'push', value, reject);
      const ref = this.$firebase.push(value, error => {
        if (error) reject(error); else resolve(new NodeFire(ref, this.$scope, this.$host));
      });
      if (ref.catch) ref.catch(noopCallback);
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
    const startTime = self.now();
    let prefetchDoneTime;
    const metadata = {};
    options = options || {};
    if (options.prefetchValue === undefined) options.prefetchValue = true;

    function fillMetadata(outcome) {
      if (metadata.outcome) return;
      metadata.outcome = outcome;
      metadata.tries = tries;
      if (prefetchDoneTime) {
        metadata.prefetchDuration = prefetchDoneTime - startTime;
        metadata.duration = self.now() - prefetchDoneTime;
      } else {
        metadata.duration = self.now() - startTime;
      }
    }

    const promise = new Promise((resolve, reject) => {
      const wrappedRejectNoResult = wrapReject(self, 'transaction', reject);
      let wrappedReject = wrappedRejectNoResult;
      let aborted;
      let lastInputValue;
      let numConsecutiveEqualInputValues = 0;

      function wrappedUpdateFunction(value) {
        try {
          wrappedReject = wrappedRejectNoResult;
          if (aborted) return;  // transaction otherwise aborted and promise settled, just stop
          if (options.detectStuck) {
            if (lastInputValue !== undefined && _.isEqual(value, lastInputValue)) {
              numConsecutiveEqualInputValues++;
            } else {
              numConsecutiveEqualInputValues = 0;
              lastInputValue = _.cloneDeep(value);
            }
            if (numConsecutiveEqualInputValues >= options.detectStuck) {
              throw new Error('stuck' + (value === null ? ' (null)' : ''));
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
        if (!prefetchDoneTime) prefetchDoneTime = self.now();
        try {
          self.$firebase.transaction(wrappedUpdateFunction, (error, committed, snap) => {
            if (error && (error.message === 'set' || error.message === 'disconnect')) {
              txn();
              return;
            }
            if (options.timeout) clearTimeout(timeoutId);
            if (options.prefetchValue) self.$firebase.off('value', onceTxn);
            fillMetadata(error ? 'error' : (committed ? 'commit': 'skip'));
            if (NodeFire.LOG_TRANSACTIONS) {
              console.log(JSON.stringify({txn: {
                tries: tries, path: self.toString().replace(/https:\/\/[^\/]*/, ''),
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
        } catch(e) {
          wrappedReject(e);
        }
      }
      if (options.timeout) {
        timeoutId = setTimeout(() => {
          aborted = true;
          reject(new Error('timeout'));
        }, options.timeout);
      }
      if (options.prefetchValue) {
        // Prefetch the data and keep it "live" during the transaction, to avoid running the
        // (potentially expensive) transaction code 2 or 3 times while waiting for authoritative
        // data from the server.  Also pull it into the cache to speed future transactions at this
        // ref.
        self.cache();
        onceTxn = _.once(txn);
        self.$firebase.on('value', onceTxn, wrappedRejectNoResult);
      } else {
        txn();
      }
    });

    promise.transaction = metadata;
    return promise;
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
    this.$firebase.on(eventType, captureCallback(this, callback), cancelCallback, context);
    return callback;
  }

  /**
   * Unregisters a listener.  Works the same as the Firebase method.
   */
  off(eventType, callback, context) {
    this.$firebase.off(eventType, callback && callback.$nodeFireCallbacks.pop(), context);
  }

  /**
   * Listens for exactly one event of the given event type, then stops listening.  Works the same as
   * the Firebase method, except that the snapshot passed into the callback will be wrapped like for
   * the on() method.
   */
  once(eventType, callback, failureCallback, context) {
    failureCallback = wrapReject(this, 'on', failureCallback);
    this.$firebase.once(eventType, function (snap, previousChildKey) {
      runGenerator(callback.call(this, new Snapshot(snap, this), previousChildKey));
    }, failureCallback, context).catch(noopCallback);
  }

  /**
   * Generates a unique string that can be used as a key in Firebase.
   * @return {string} A unique string that satisfies Firebase's key syntax constraints.
   */
  generateUniqueKey() {
    return this.$firebase.push().key();
  }

  /**
   * Returns the current timestamp after adjusting for the Firebase-computed server time offset.
   * @return {number} The current time in integer milliseconds since the epoch.
   */
  now() {
    return new Date().getTime() + serverTimeOffsets[this.$host];
  }

  /**
   * Turn Firebase low-level connection logging on or off.
   * @param {boolean | ROLLING} enable Whether to enable or disable logging, or enable rolling logs.
   *        Rolling logs can only be enabled once; any further calls to enableFirebaseLogging will
   *        disable them permanently.
   * @returns If ROLLING logs were requested, returns a handle to FirebaseRollingLog (see
   *          https://github.com/mikelehen/firebase-rolling-log for details).  Otherwise returns
   *          nothing.
   */
  static enableFirebaseLogging(enable) {
    if (enable === NodeFire.ROLLING) {
      return require('firebase-rolling-log');
    } else {
      Firebase.enableLogging(enable);
    }
  }

  /**
   * Sets the maximum number of values to keep pinned and updated in the cache.  The cache is not
   * used unless you set a non-zero maximum.
   * @param {number} max The maximum number of values to keep pinned in the cache.
   */
  static setCacheSize(max) {
    if (max) {
      if (!cache) {
        cache = new LRUCache({max: max, dispose: (key, ref) => {
          ref.off('value', noopCallback);
        }});
      } else {
        cache.max = max;
      }
    } else {
      if (cache) cache.reset();
      cache = null;
    }
  }

  /**
   * Sets the maximum number of pinned values to retain in the cache when a host gets disconnected.
   * By default all values are retained, but if your cache size is high they'll all need to be
   * double-checked against the Firebase server when the connection comes back.  It may thus be more
   * economical to drop the least used ones when disconnected.
   * @param {number} max The maximum number of values from a disconnected host to keep pinned in the
   *        cache.
   */
  static setCacheSizeForDisconnectedHost(max) {
    maxCacheSizeForDisconnectedHost = max;
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
      return key.toString().replace(/[\\\.\$\#\[\]\/]/g, char => {
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

/**
 * A special constant that you can pass to enableFirebaseLogging to keep a rolling buffer of
 * Firebase logs without polluting the console, to be grabbed and saved only when needed.
 */
NodeFire.ROLLING = {};

/* Some static methods copied over from the Firebase class. */
NodeFire.goOffline = Firebase.goOffline;
NodeFire.goOnline = Firebase.goOnline;
NodeFire.ServerValue = Firebase.ServerValue;

/* Some methods that work the same as on Firebase objects. */
wrapNodeFire('parent');
wrapNodeFire('root');
delegateNodeFire('key');

/* Query methods, same as on Firebase objects. */
wrapNodeFire('limitToFirst');
wrapNodeFire('limitToLast');
wrapNodeFire('startAt');
wrapNodeFire('endAt');
wrapNodeFire('equalTo');
wrapNodeFire('orderByChild');
wrapNodeFire('orderByKey');
wrapNodeFire('orderByValue');
wrapNodeFire('orderByPriority');
wrapNodeFire('ref');


// We need to wrap the user's callback so that we can wrap each snapshot, but must keep track of the
// wrapper function in case the user calls off().  We don't reuse wrappers so that the number of
// wrappers is equal to the number of on()s for that callback, and we can safely pop one with each
// call to off().
function captureCallback(nodeFire, callback) {
  callback.$nodeFireCallbacks = callback.$nodeFireCallbacks || [];
  const nodeFireCallback = function(snap, previousChildKey) {
    runGenerator(callback.call(this, new Snapshot(snap, nodeFire), previousChildKey));
  };
  callback.$nodeFireCallbacks.push(nodeFireCallback);
  return nodeFireCallback;
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


function delegateNodeFire(method) {
  NodeFire.prototype[method] = function() {
    return this.$firebase[method].apply(this.$firebase, arguments);
  };
}

function wrapNodeFire(method) {
  NodeFire.prototype[method] = function() {
    return new NodeFire(
      this.$firebase[method].apply(this.$firebase, arguments), undefined, this.$host);
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
    error.message = 'Firebase: ' + error.message;
    error.firebase = {method: method, ref: nodefire.toString()};
    if (hasValue) error.firebase.value = value;
    reject(error);
  };
}

function noopCallback() {}

function trackTimeOffset(host) {
  new Firebase('https://' + host + '/.info/serverTimeOffset').on('value', snap => {
    serverTimeOffsets[host] = snap.val();
  }, _.bind(trackTimeOffset, host));
}

function trackDisconnect(host) {
  serverDisconnects[host] = new Firebase('https://' + host + '/.info/connected').on(
    'value', snap => {
      if (!snap.val()) trimCache(host);
    }, _.bind(trackDisconnect, host)
  );
}

function trimCache(host) {
  if (!cache || cache.max <= maxCacheSizeForDisconnectedHost) return;
  const prefix = 'https://' + host + '/';
  let count = 0;
  cache.forEach((value, key) => {
    if (key.slice(0, prefix.length) !== prefix) return;
    if (++count <= maxCacheSizeForDisconnectedHost) return;
    cache.del(key);
  });
}

function getNormalValue(snap) {
  const value = getNormalRawValue(snap.val());
  if (snap.getPriority() !== null && _.isObject(value)) value['.priority'] = snap.getPriority();
  return value;
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

module.exports = NodeFire;

