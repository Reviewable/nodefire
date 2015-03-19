'use strict';

require('es6-promise').polyfill();
var Firebase = require('firebase');
var FirebaseTokenGenerator = require('firebase-token-generator');
var _ = require('underscore');
var url = require('url');
var LRUCache = require('lru-cache');
var co = require('co');

var cache;
var serverTimeOffsets = {};

function noopCallback() {}

/**
 * A wrapper around a Firebase reference, and the main entry point to the module.  You can pretty
 * much use this class as you would use the Firebase class.  The two major differences are:
 * 1) Most methods return promises, which you use instead of callbacks.
 * 2) Each NodeFire object has a scope dictionary associated with it that's used to interpolate any
 *    path used in a call.
 *
 * @param {string || Firebase} refOrUrl The Firebase URL (or Firebase reference instance) that this
 *     object will represent.
 * @param {Object} scope Optional dictionary that will be used for interpolating paths.
 * @param {string} host For internal use only, do not pass.
 */
var NodeFire = function(refOrUrl, scope, host) {
  if (_.isString(refOrUrl)) refOrUrl = new Firebase(refOrUrl);
  this.$firebase = refOrUrl;
  this.$scope = scope || {};
  if (!host) host = url.parse(refOrUrl.toString()).host;
  this.$host = host;
  if (!(host in serverTimeOffsets)) {
    serverTimeOffsets[host] = 0;
    new Firebase('https://' + host + '/.info/serverTimeOffset').on('value', function(snap) {
      serverTimeOffsets[host] = snap.val();
    });
  }
};
module.exports = NodeFire;

/** A wrapper around a Firebase DataSnapshot.  Works just like a Firebase snapshot, except that
    ref() returns a NodeFire instance, val() normalizes the value, and child() takes an optional
    refining scope.
 */
var Snapshot = function(snap, nodeFire) {
  this.$snap = snap;
  this.$nodeFire = nodeFire;
};

/**
 * Flag that indicates whether to run in debug mode.  Currently only has an effect on calls to
 *     auth(), and must be set to the desired value before any such calls.  Note that turning on
 *     debug mode will slow down processing of Firebase commands and increase required bandwidth.
 * @type {boolean} True to put the library into debug mode, false otherwise.
 */
NodeFire.DEBUG = false;

/* Some static methods copied over from the Firebase class. */
NodeFire.goOffline = Firebase.goOffline;
NodeFire.goOnline = Firebase.goOnline;
NodeFire.ServerValue = Firebase.ServerValue;

/**
 * Sets the maximum number of values to keep pinned and updated in the cache.  The cache is not used
 * unless you set a non-zero maximum.
 * @param {number} max The maximum number of values to keep pinned in the cache.
 */
NodeFire.setCacheSize = function(max) {
  if (max) {
    if (!cache) {
      cache = new LRUCache({max: max, dispose: function(key, ref) {
        ref.off('value', noopCallback);
      }});
    } else {
      cache.max = max;
    }
  } else {
    if (cache) cache.reset();
    cache = null;
  }
};

/**
 * Gets the current number of values pinned in the cache.
 * @return {number} The current size of the cache.
 */
NodeFire.getCacheCount = function() {
  return cache ? cache.itemCount : 0;
};

/**
 * Interpolates variables into a template string based on the object's scope (passed into the
 * constructor, if any) and the optional scope argument.  Characters forbidden by Firebase are
 * escaped into a "\xx" hex format.
 *
 * @param  {string} string The template string to interpolate.  You can refer to scope variables
 *     using both ":varName" and "{varName}" notations, with the latter also accepting dot-separated
 *     child attributes like "{varName.child1.child2}".
 * @param  {Object} scope Optional bindings to add to the ones carried by this NodeFire object.
 *     This scope takes precedence if a key is present in both.
 * @return {string} The interpolated string
 */
NodeFire.prototype.interpolate = function(string, scope) {
  scope = scope ? _.extend(_.clone(this.$scope), scope) : this.$scope;
  string = string.replace(/:([a-z-_]+)|\{(.+?)\}/gi, function(match, v1, v2) {
    var v = (v1 || v2);
    var parts = v.split('.');
    var value = scope;
    for (var i = 0; i < parts.length; i++) {
      value = value[parts[i]];
      if (_.isUndefined(value) || value === null) {
        throw new Error(
          'Missing or null variable "' + v + '" when expanding NodeFire path "' + string + '"');
      }
    }
    return value.toString().replace(/[\\\.\$\#\[\]\/]/g, function(char) {
      return '\\' + char.charCodeAt(0).toString(16);
    });
  });
  return string;
};

// TODO: add onDisconnect

/**
 * Authenticates with Firebase, using either a secret or a custom token.  To enable security rule
 * debugging, set NodeFire.DEBUG to true and pass an authObject into this function.
 * @param  {string} secret A secret for the Firebase referenced by this NodeFire object (copy from
 *     the Firebase dashboard).
 * @param  {Object} authObject Optional.  If provided, instead of authenticating with the secret
 *     directly (which disables all security checks), we'll generate a custom token with the auth
 *     value provided here, an expiry far in the future, and the debug flag set if NodeFire.DEBUG is
 *     true.
 * @return {Promise} A promise that is resolved when the authentication has completed successfully,
 *     and rejected with an error if it failed.
 */
NodeFire.prototype.auth = function(secret, authObject) {
  var token = secret;
  if (authObject) {
    // Tokens expire 10 years from now.
    token = new FirebaseTokenGenerator(secret).createToken(
      authObject, {expires: this.now() + 315360000, debug: NodeFire.DEBUG});
    if (NodeFire.DEBUG) interceptFirebaseDebugLogs();
  }
  return new Promise(_.bind(function(resolve, reject) {
    this.$firebase.authWithCustomToken(token, function(error, value) {
      if (error) reject(error); else resolve(value);
    });
  }, this));
};

/**
 * Unauthenticates from Firebase.
 * @return {Promise} A resolved promise (for consistency, since unauthentication is immediate).
 */
NodeFire.prototype.unauth = function() {
  this.$firebase.unauth();
  return Promise.resolved(null);
};

/**
 * Stringifies the wrapped reference.
 * @return {string} The Firebase URL wrapped by this NodeFire object.
 */
NodeFire.prototype.toString = function() {
  return decodeURIComponent(this.$firebase.toString());
};

/**
 * Creates a new NodeFire object on the same reference, but with an extended interpolation scope.
 * @param  {Object} scope A dictionary of interpolation variables that will be added to (and take
 *     precedence over) the one carried by this NodeFire object.
 * @return {NodeFire} A new NodeFire object with the same reference and new scope.
 */
NodeFire.prototype.scope = function(scope) {
  return new NodeFire(this.$firebase, _.extend(_.clone(this.$scope), scope), this.$host);
};

/**
 * Creates a new NodeFire object on a child of this one, and optionally an augmented scope.
 * @param  {string} path The path to the desired child, relative to this reference.  The path will
 *     be interpolated using this object's scope and the additional scope provided.  For the syntax
 *     see the interpolate() method.
 * @param  {Object} scope Optional additional scope that will add to (and override) this object's
 *     scope.
 * @return {NodeFire} A new NodeFire object on the child reference, and with the augmented scope.
 */
NodeFire.prototype.child = function(path, scope) {
  var child = this.scope(scope);
  return new NodeFire(this.$firebase.child(child.interpolate(path)), child.$scope, this.$host);
};

/**
 * Gets this reference's current value from Firebase, and inserts it into the cache if a
 * maxCacheSize was set.
 * @return {Promise} A promise that is resolved to the reference's value, or rejected with an error.
 *     The value returned is normalized: arrays are converted to objects, and the value's priority
 *     (if any) is set on a ".priority" attribute if the value is an object.
 */
NodeFire.prototype.get = function() {
  var self = this;
  var url = this.toString();
  if (cache && !cache.has(url)) {
    cache.set(url, this);
    this.on('value', noopCallback);
  }
  return new Promise(function(resolve, reject) {
    reject = wrapReject(self, 'get', reject);
    self.$firebase.once('value', function(snap) {
      resolve(getNormalValue(snap));
    }, reject);
  });
};

/**
 * Sets the value at this reference.  To set the priority, include a ".priority" attribute on the
 * value.
 * @param {Object || number || string || boolean} value The value to set.
 * @returns {Promise} A promise that is resolved when the value has been set, or rejected with an
 *     error.
 */
NodeFire.prototype.set = function(value) {
  var self = this;
  return new Promise(function(resolve, reject) {
    reject = wrapReject(self, 'set', reject);
    self.$firebase.set(value, function(error) {
      if (error) reject(error); else resolve();
    });
  });
};

/**
 * Sets the priority at this reference.  Useful because you can't pass a ".priority" key to
 * update().
 * @param {string || number} priority The priority for the data at this reference.
 * @returns {Promise} A promise that is resolved when the priority has been set, or rejected with an
 *     error.
 */
NodeFire.prototype.setPriority = function(priority) {
  var self = this;
  return new Promise(function(resolve, reject) {
    reject = wrapReject(self, 'setPriority', reject);
    self.$firebase.setPriority(priority, function(error) {
      if (error) reject(error); else resolve();
    });
  });
};

/**
 * Updates a value at this reference, setting only the top-level keys supplied and leaving any other
 * ones as-is.
 * @param  {Object} value The value to update the reference with.
 * @return {Promise} A promise that is resolved when the value has been updated, or rejected with an
 *     error.
 */
NodeFire.prototype.update = function(value) {
  var self = this;
  return new Promise(function(resolve, reject) {
    reject = wrapReject(self, 'update', reject);
    self.$firebase.update(value, function(error) {
      if (error) reject(error); else resolve();
    });
  });
};

/**
 * Removes this reference from the Firebase.
 * @return {Promise} A promise that is resolved when the value has been removed, or rejected with an
 *     error.
 */
NodeFire.prototype.remove = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    reject = wrapReject(self, 'remove', reject);
    self.$firebase.remove(function(error) {
      if (error) reject(error); else resolve();
    });
  });
};

/**
 * Pushes a value as a new child of this reference, with a new unique key.  Note that if you just
 * want to generate a new unique key you can call generateUniqueKey() directly.
 * @param  {Object || number || string || boolean} value The value to push.
 * @return {Promise} A promise that is resolved to a new NodeFire object that refers to the newly
 *     pushed value (with the same scope as this object), or rejected with an error.
 */
NodeFire.prototype.push = function(value) {
  var self = this;
  return new Promise(function(resolve, reject) {
    reject = wrapReject(self, 'push', reject);
    var ref = self.$firebase.push(value, function(error) {
      if (error) reject(error); else resolve(new NodeFire(ref, self.$scope, self.$host));
    });
  });
};

/**
 * Runs a transaction at this reference.
 * @param  {function(value):value} updateFunction A function that takes the current value at this
 *     reference and returns the new value to replace it with.  Return undefined to abort the
 *     transaction, and null to remove the reference.  Be prepared for this function to be called
 *     multiple times in case of contention.
 * @param  {boolean} applyLocally True if you want the effect of the transaction to be visible
 *     locally before it has been confirmed at the server.  Defaults to false.
 * @return {Promise} A promise that is resolved with the (normalized) committed value if the
 *     transaction committed or with undefined if it aborted, or rejected with an error.
 */
NodeFire.prototype.transaction = function(updateFunction, applyLocally) {
  var self = this;
  applyLocally = applyLocally || false;
  return new Promise(function(resolve, reject) {
    reject = wrapReject(self, 'transaction', reject);
    var txn = _.once(function() {
      try {
        self.$firebase.transaction(updateFunction, function(error, committed, snap) {
          self.$firebase.off('value', txn);
          if (error) {
            reject(error);
          } else if (committed) {
            resolve(getNormalValue(snap));
          } else {
            resolve();
          }
        }, applyLocally);
      } catch(e) {
        reject(e);
      }
    });
    // Prefetch the data and keep it "live" during the transaction, to avoid running the
    // (potentially expensive) transaction code 2 or 3 times while waiting for authoritative data
    // from the server.
    self.$firebase.on('value', txn);
  });
};

// TODO: add user/password-related methods

// We need to wrap the user's callback so that we can wrap each snapshot, but must keep track of the
// wrapper function in case the user calls off().  We don't reuse wrappers so that the number of
// wrappers is equal to the number of on()s for that callback, and we can safely pop one with each
// call to off().
function captureCallback(nodeFire, callback) {
  callback.$nodeFireCallbacks = callback.$nodeFireCallbacks || [];
  var nodeFireCallback = function(snap, previousChildKey) {
    runGenerator(callback.call(this, new Snapshot(snap, nodeFire), previousChildKey));
  };
  callback.$nodeFireCallbacks.push(nodeFireCallback);
  return nodeFireCallback;
}

function runGenerator(o) {
  var promise;
  if (o instanceof Promise) {
    promise = o;
  } else if (o && typeof o.next === 'function' && typeof o.throw === 'function') {
    promise = co(o);
  }
  if (promise) promise.catch(function(error) {throw error;});
}

/**
 * Registers a listener for an event on this reference.  Works the same as the Firebase method
 * except that the snapshot passed into the callback will be wrapped such that:
 *   1) The val() method will return a normalized method (like NodeFire.get() does).
 *   2) The ref() method will return a NodeFire reference, with the same scope as the reference
 *      on which on() was called.
 *   3) The child() method takes an optional extra scope parameter, just like NodeFire.child().
 */
NodeFire.prototype.on = function(eventType, callback, cancelCallback, context) {
  cancelCallback = wrapReject(this, 'on', cancelCallback);
  this.$firebase.on(eventType, captureCallback(this, callback), cancelCallback, context);
  return callback;
};

/**
 * Unregisters a listener.  Works the same as the Firebase method.
 */
NodeFire.prototype.off = function(eventType, callback, context) {
  this.$firebase.off(eventType, callback && callback.$nodeFireCallbacks.pop(), context);
};

/**
 * Listens for exactly one event of the given event type, then stops listening.  Works the same as
 * the Firebase method, except that the snapshot passed into the callback will be wrapped like for
 * the on() method.
 */
NodeFire.prototype.once = function(eventType, callback, failureCallback, context) {
  var self = this;
  failureCallback = wrapReject(this, 'on', failureCallback);
  this.$firebase.once(eventType, function(snap, previousChildKey) {
    runGenerator(callback.call(this, new Snapshot(snap, self), previousChildKey));
  }, failureCallback, context);
};

/**
 * Generates a unique string that can be used as a key in Firebase.
 * @return {string} A unique string that satisfies Firebase's key syntax constraints.
 */
NodeFire.prototype.generateUniqueKey = function() {
  return this.$firebase.push().key();
};

/**
 * Returns the current timestamp after adjusting for the Firebase-computed server time offset.
 * @return {number} The current time in integer milliseconds since the epoch.
 */
NodeFire.prototype.now = function() {
  return new Date().getTime() + serverTimeOffsets[this.$host];
};

Snapshot.prototype.val = function() {
  return getNormalValue(this.$snap);
};

Snapshot.prototype.child = function(path, scope) {
  var childNodeFire = this.$nodeFire.scope(scope);
  return new Snapshot(this.$snap.child(childNodeFire.interpolate(path)), childNodeFire);
};

Snapshot.prototype.forEach = function(callback) {
  this.$snap.forEach(function(child) {
    return callback(new Snapshot(child, this.$nodeFire));
  });
};

Snapshot.prototype.ref = function() {
  return new NodeFire(this.$snap.ref(), this.$nodeFire.$scope, this.$nodeFire.$host);
};

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

/* Snapshot methods that work the same. */
delegateSnapshot('exists');
delegateSnapshot('hasChild');
delegateSnapshot('hasChildren');
delegateSnapshot('key');
delegateSnapshot('numChildren');
delegateSnapshot('getPriority');
delegateSnapshot('exportVal');

function wrapReject(nodefire, method, reject) {
  return function(error) {
    reject(new Error('Firebase ' + method + '(' + nodefire.toString() + '): ' + error));
  };
}

function getNormalValue(snap) {
  var value = snap.val();
  if (_.isArray(value)) {
    var normalValue = {};
    _.forEach(value, function(item, key) {
      if (!(item === null || _.isUndefined(item))) {
        normalValue[key] = item;
      }
    });
    value = normalValue;
  }
  if (snap.getPriority() !== null && _.isObject(value)) value['.priority'] = snap.getPriority();
  return value;
}

function interceptFirebaseDebugLogs() {
  var originalLog = console.log;
  var logBuffer = [];
  console.log = function() {
    if (arguments.length && /^FIREBASE:/.test(arguments[0])) {
      var message = Array.prototype.slice.call(arguments).join(' ');
      if (/^FIREBASE: Attempt to (read|write)/.test(message)) logBuffer = [];
      logBuffer.push(message);
      if (/^FIREBASE: (Read|Write) was denied/.test(message)) {
        originalLog('Firebase permission denied debug log:\n' + logBuffer.join('\n'));
      }
      if (/^FIREBASE: (Read|Write) was (allowed|denied)/.test(message)) logBuffer = [];
    } else {
      originalLog.apply(this, arguments);
    }
  };
}
