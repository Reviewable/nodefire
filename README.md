NodeFire
========

NodeFire is a Firebase library for NodeJS that has a pretty similar API but adds the following features:

1. Most methods return a promise, instead of requiring a callback.  This works especially nicely with Node's `--harmony` flag and a framework like `co`, allowing you to control data flow with `yield` statements.
2. Any paths passed in are treated as templates and interpolated within an implicit or explicit scope, avoiding manual (and error-prone) string concatenation.  Characters forbidden by Firebase are automatically escaped.
3. Since one-time fetches of a reference are common in server code, a new `get` method makes them easy and an optional LRU cache keeps the most used ones pinned and synced to reduce latency.
4. Transactions prefetch the current value of the reference to avoid having every transaction re-executed at least twice.
5. In debug mode, traces are printed for failed security rule checks (and only failed ones).

## Example

```javascript
var co = require('co');
var NodeFire = require('nodefire');
NodeFire.setCacheSize(10);
NodeFire.DEBUG = true;
var db = new NodeFire('https://example.firebaseio.com/');
co((function*() {
  yield db.auth('secret', {uid: 'server01'});
  var stuff = db.child('stuffs', {foo: 'bar', baz: {qux: 42}});
  var data = yield {
    theFoo: stuff.child('foos/:foo').get(),
    theUser: stuff.root().child('users/{baz.qux}').get()
  };
  yield [
    stuff.child('bars/:foo/{theUser.username}', data).set(data.theFoo.bar),
    stuff.child('counters/:foo').transaction(function(value) {return value + 1;})
  ];
})());
```

## API

This is reproduced from the source code, which is authoritative.

```javascript
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
module.exports = function NodeFire(refOrUrl, scope, host);

/**
 * Flag that indicates whether to run in debug mode.  Currently only has an effect on calls to
 *     auth(), and must be set to the desired value before any such calls.  Note that turning on
 *     debug mode will slow down processing of Firebase commands and increase required bandwidth.
 * @type {boolean} True to put the library into debug mode, false otherwise.
 */
NodeFire.DEBUG = false;

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

/**
 * Turn Firebase low-level connection logging on or off.
 * @param {boolean | ROLLING} enable Whether to enable or disable logging, or enable rolling logs.
 *        Rolling logs can only be enabled once; any further calls to enableFirebaseLogging will
 *        disable them permanently.
 * @returns If ROLLING logs were requested, returns a handle to FirebaseRollingLog (see
 *          https://github.com/mikelehen/firebase-rolling-log for details).  Otherwise returns
 *          nothing.
 */
NodeFire.enableFirebaseLogging = function(enable);

/**
 * Sets the maximum number of values to keep pinned and updated in the cache.  The cache is not used
 * unless you set a non-zero maximum.
 * @param {number} max The maximum number of values to keep pinned in the cache.
 */
NodeFire.setCacheSize = function(max);

/**
 * Gets the current number of values pinned in the cache.
 * @return {number} The current size of the cache.
 */
NodeFire.getCacheCount = function();

/**
 * Gets the current cache hit rate.  This is very approximate, as it's only counted for get() and
 * transaction() calls, and is unable to count ancestor hits, where the ancestor of the requested
 * item is actually cached.
 * @return {number} The cache's current hit rate.
 */
NodeFire.getCacheHitRate = function() {
  return (cacheHits || cacheMisses) ? cacheHits / (cacheHits + cacheMisses) : 0;
};

/**
 * Resets the cache's hit rate counters back to zero.
 */
NodeFire.resetCacheHitRate = function() {
  cacheHits = cacheMisses = 0;
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
NodeFire.prototype.interpolate = function(string, scope);

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
NodeFire.prototype.auth = function(secret, authObject);

/**
 * Unauthenticates from Firebase.
 * @return {Promise} A resolved promise (for consistency, since unauthentication is immediate).
 */
NodeFire.prototype.unauth = function();

/**
 * Creates a new NodeFire object on the same reference, but with an extended interpolation scope.
 * @param  {Object} scope A dictionary of interpolation variables that will be added to (and take
 *     precedence over) the one carried by this NodeFire object.
 * @return {NodeFire} A new NodeFire object with the same reference and new scope.
 */
NodeFire.prototype.scope = function(scope);

/**
 * Creates a new NodeFire object on a child of this one, and optionally an augmented scope.
 * @param  {string} path The path to the desired child, relative to this reference.  The path will
 *     be interpolated using this object's scope and the additional scope provided.  For the syntax
 *     see the interpolate() method.
 * @param  {Object} scope Optional additional scope that will add to (and override) this object's
 *     scope.
 * @return {NodeFire} A new NodeFire object on the child reference, and with the augmented scope.
 */
NodeFire.prototype.child = function(path, scope);

/**
 * Gets this reference's current value from Firebase, and inserts it into the cache if a
 * maxCacheSize was set.
 * @return {Promise} A promise that is resolved to the reference's value, or rejected with an error.
 *     The value returned is normalized: arrays are converted to objects, and the value's priority
 *     (if any) is set on a ".priority" attribute if the value is an object.
 */
NodeFire.prototype.get = function();

/**
 * Sets the value at this reference.  To set the priority, include a ".priority" attribute on the
 * value.
 * @param {Object || number || string || boolean} value The value to set.
 * @returns {Promise} A promise that is resolved when the value has been set, or rejected with an
 *     error.
 */
NodeFire.prototype.set = function(value);

/**
 * Sets the priority at this reference.  Useful because you can't pass a ".priority" key to
 * update().
 * @param {string || number} priority The priority for the data at this reference.
 * @returns {Promise} A promise that is resolved when the priority has been set, or rejected with an
 *     error.
 */
NodeFire.prototype.setPriority = function(priority);

/**
 * Updates a value at this reference, setting only the top-level keys supplied and leaving any other
 * ones as-is.
 * @param  {Object} value The value to update the reference with.
 * @return {Promise} A promise that is resolved when the value has been updated, or rejected with an
 *     error.
 */
NodeFire.prototype.update = function(value);

/**
 * Removes this reference from the Firebase.
 * @return {Promise} A promise that is resolved when the value has been removed, or rejected with an
 *     error.
 */
NodeFire.prototype.remove = function();

/**
 * Pushes a value as a new child of this reference, with a new unique key.  Note that if you just
 * want to generate a new unique key you can call generateUniqueKey() directly.
 * @param  {Object || number || string || boolean} value The value to push.
 * @return {Promise} A promise that is resolved to a new NodeFire object that refers to the newly
 *     pushed value (with the same scope as this object), or rejected with an error.
 */
NodeFire.prototype.push = function(value);

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
NodeFire.prototype.transaction = function(updateFunction, applyLocally);

/**
 * Generates a unique string that can be used as a key in Firebase.
 * @return {string} A unique string that satisfies Firebase's key syntax constraints.
 */
NodeFire.prototype.generateUniqueKey = function();

/**
 * Returns the current timestamp after adjusting for the Firebase-computed server time offset.
 * @return {number} The current time in integer milliseconds since the epoch.
 */
NodeFire.prototype.now = function();

/* Some methods that work the same as on Firebase objects. */
NodeFire.prototype.parent = function();
NodeFire.prototype.root = function();
NodeFire.prototype.toString = function();
NodeFire.prototype.key = function();
NodeFire.prototype.ref = function();

/* Listener registration methods.  They work the same as on Firebase objects, except that the
   snapshot passed into the callback (and forEach) is wrapped such that:
     1) The val() method will return a normalized method (like NodeFire.get() does).
     2) The ref() method will return a NodeFire reference, with the same scope as the reference
        on which on() was called.
     3) The child() method takes an optional extra scope parameter, just like NodeFire.child().
*/
NodeFire.prototype.on = function(eventType, callback, cancelCallback, context);
NodeFire.prototype.off = function(eventType, callback, context);
NodeFire.prototype.once = function(eventType, successCallback, failureCallback, context);

/* Query methods, same as on Firebase objects. */
NodeFire.prototype.limitToFirst = function(limit);
NodeFire.prototype.limitToLast = function(limit);
NodeFire.prototype.startAt = function(priority, name);
NodeFire.prototype.endAt = function(priority, name);
NodeFire.prototype.equalTo = function(value, key);
NodeFire.prototype.orderByChild = function(key);
NodeFire.prototype.orderByKey = function();
NodeFire.prototype.orderByPriority = function();
```
