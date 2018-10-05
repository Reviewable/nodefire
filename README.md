NodeFire
========

[![Project Status: Active - The project has reached a stable, usable state and is being actively developed.](http://www.repostatus.org/badges/latest/active.svg)](http://www.repostatus.org/#active)

NodeFire expands the [Firebase Admin SDK](https://firebase.google.com/docs/admin/setup) with the
following features:

1. Any paths passed in are treated as templates and interpolated within an implicit or explicit scope, avoiding manual (and error-prone) string concatenation.  Characters forbidden by Firebase are automatically escaped.
1. Since one-time fetches of a reference are common in server code, a new `get` method makes them easy and an optional LRU cache keeps the most used ones pinned and synced to reduce latency.
1. Transactions prefetch the current value of the reference to avoid having every transaction re-executed at least twice.
1. A `childrenKeys()` method allows you to perform a shallow query to fetch a `Reference`'s children keys without fetching all of its data.

If you'd like to be able to use generators as `on` or `once` callbacks, make sure to set `Promise.on` to a `co`-compatible function.

## Example

```javascript
const co = require('co');
const admin = require('firebase-admin');
const NodeFire = require('nodefire');

NodeFire.setCacheSize(10);

admin.initializeApp(
  // ...
);

const db = new NodeFire(admin.database().ref())

co(
  (function*() {
    var stuff = db.child('stuffs', {
      foo: 'bar',
      baz: {
        qux: 42
      }
    });

    var data = yield {
      theFoo: stuff.child('foos/:foo').get(),
      theUser: stuff.root.child('users/{baz.qux}').get(),
    };
    
    yield [
      stuff.child('counters/:foo').transaction((value) => value + 1),
      stuff.child('bars/:foo/{theUser.username}', data).set(data.theFoo.bar),
    ];
  })()
);
```

## API

This is reproduced from the source code, which is authoritative.

```javascript
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
class NodeFire;

/**
 * Creates a new NodeFire wrapper around a raw Firebase Admin reference.
 *
 * @param {admin.database.Query} refOrUrl A fully authenticated Firebase Admin reference or query.
 * @param {Object} options Optional dictionary containing options.
  * @param {Object} options.scope Optional dictionary that will be used for interpolating paths.
  * @param {string} options.host For internal use only, do not pass.
 */
constructor(ref, options)

/**
 * Flag that indicates whether to log transactions and the number of tries needed.
 * @type {boolean} True to log metadata about every transaction.
 */
static LOG_TRANSACTIONS = false

/**
 * Returns a placeholder value for auto-populating the current timestamp (time since the Unix
 * epoch, in milliseconds) as determined by the Firebase servers.
 * @return {Object} A timestamp placeholder value.
 */
static SERVER_TIMESTAMP

/**
 * Turns Firebase low-level connection logging on or off.
 * @param {boolean} enable Whether to enable or disable logging.
 */
static enableFirebaseLogging(enable)

/**
 * Adds an intercepting callback before all NodeFire database operations.  This callback can
 * modify the operation's options or block it while performing other work.
 * @param {Function} callback The callback to invoke before each operation.  It will be passed two
 *     arguments: an operation descriptor ({ref, method, args}) and an options object.  The
 *     descriptor is read-only but the options can be modified.  The callback can return any value
 *     (which will be ignored) or a promise, to block execution of the operation (but not other
 *     interceptors) until the promise settles.
 */
static interceptOperations(callback)

/**
 * Sets the maximum number of values to keep pinned and updated in the cache.  The cache is not used
 * unless you set a non-zero maximum.
 * @param {number} max The maximum number of values to keep pinned in the cache.
 */
static setCacheSize(max)

/**
 * Sets the maximum number of pinned values to retain in the cache when a host gets disconnected.
 * By default all values are retained, but if your cache size is high they'll all need to be double-
 * checked against the Firebase server when the connection comes back.  It may thus be more
 * economical to drop the least used ones when disconnected.
 * @param {number} max The maximum number of values from a disconnected host to keep pinned in the
 *        cache.
 */
static setCacheSizeForDisconnectedHost(max)

/**
 * Gets the current number of values pinned in the cache.
 * @return {number} The current size of the cache.
 */
static getCacheCount()

/**
 * Gets the current cache hit rate.  This is very approximate, as it's only counted for get() and
 * transaction() calls, and is unable to count ancestor hits, where the ancestor of the requested
 * item is actually cached.
 * @return {number} The cache's current hit rate.
 */
static getCacheHitRate()

/**
 * Resets the cache's hit rate counters back to zero.
 */
static resetCacheHitRate()

/**
 * Escapes a string to make it an acceptable Firebase key.
 * @param {string} key The proposed key to escape.
 * @return {string} The escaped key.
 */
static escape(key)

/**
 * Unescapes a previously escaped (or interpolated) key.
 * @param {string} key The key to unescape.
 * @return {string} The original unescaped key.
 */
static unescape(key)

/**
 * @property {string} The path component of the reference's URL.
 */
path

/**
 * Properties which work the same as the standard Firebase Admin SDK.
 */
key
ref
root
parent
database

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
interpolate(string, scope)

/**
 * Creates a new NodeFire object on the same reference, but with an extended interpolation scope.
 * @param  {Object} scope A dictionary of interpolation variables that will be added to (and take
 *     precedence over) the one carried by this NodeFire object.
 * @return {NodeFire} A new NodeFire object with the same reference and new scope.
 */
scope(scope)

/**
 * Creates a new NodeFire object on a child of this one, and optionally an augmented scope.
 * @param  {string} path The path to the desired child, relative to this reference.  The path will
 *     be interpolated using this object's scope and the additional scope provided.  For the syntax
 *     see the interpolate() method.
 * @param  {Object} scope Optional additional scope that will add to (and override) this object's
 *     scope.
 * @return {NodeFire} A new NodeFire object on the child reference, and with the augmented scope.
 */
child(path, scope)

/**
 * Gets this reference's current value from Firebase, and inserts it into the cache if a
 * maxCacheSize was set and the `cache` option is not false.
 * @return {Promise} A promise that is resolved to the reference's value, or rejected with an error.
 *     The value returned is normalized: arrays are converted to objects, and the value's priority
 *     (if any) is set on a ".priority" attribute if the value is an object.
 */
get()

/**
 * Adds this reference to the cache (if maxCacheSize set) and counts a cache hit or miss.
 */
cache()

/**
 * Removes this reference from the cache (if maxCacheSize is set).
 * @return True if the reference was cached, false otherwise.
 */
uncache()

/**
 * Sets the value at this reference.  To set the priority, include a ".priority" attribute on the
 * value.
 * @param {Object || number || string || boolean} value The value to set.
 * @returns {Promise} A promise that is resolved when the value has been set, or rejected with an
 *     error.
 */
set(value)

/**
 * Updates a value at this reference, setting only the top-level keys supplied and leaving any other
 * ones as-is.
 * @param  {Object} value The value to update the reference with.
 * @return {Promise} A promise that is resolved when the value has been updated, or rejected with an
 *     error.
 */
update(value)

/**
 * Removes this reference from the Firebase.
 * @return {Promise} A promise that is resolved when the value has been removed, or rejected with an
 *     error.
 */
remove()

/**
 * Pushes a value as a new child of this reference, with a new unique key.  Note that if you just
 * want to generate a new unique key you can call generateUniqueKey() directly.
 * @param  {Object || number || string || boolean} value The value to push.
 * @return {Promise} A promise that is resolved to a new NodeFire object that refers to the newly
 *     pushed value (with the same scope as this object), or rejected with an error.
 */
push(value)

/**
 * Runs a transaction at this reference.  The transaction is not applied locally first, since this
 * would be incompatible with a promise's complete-once semantics.
 *
 * There's a bug in the Firebase SDK that fails to update the local value and will cause a
 * transaction to fail repeatedly until it fails with maxretry.  If you specify the detectStuck
 * option then an error with the message 'stuck' will be thrown earlier so that you can try to work
 * around the issue.
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
transaction(updateFunction, options)

/**
 * Fetches the keys of the current reference's children without also fetching all the contents,
 * using the Firebase REST API.
 * 
 * @param options An options object with the following items, all optional:
 *   - maxTries: the maximum number of times to try to fetch the keys, in case of transient errors
 *               (defaults to 1)
 *   - retryInterval: the number of milliseconds to delay between retries (defaults to 1000)
 * @return A promise that resolves to an array of key strings.
 */
childrenKeys(options)

/**
 * Generates a unique string that can be used as a key in Firebase.
 * @return {string} A unique string that satisfies Firebase's key syntax constraints.
 */
generateUniqueKey()

/**
 * Returns the current timestamp after adjusting for the Firebase-computed server time offset.
 * @return {number} The current time in integer milliseconds since the epoch.
 */
now()

/**
 * Returns whether or not this NodeFire instance is equivalent to the provided NodeFire instance.
 * @return {NodeFire} Another NodeFire instance against which to compare.
 */
isEqual()

/* Some methods that work the same as on Firebase objects. */
toJSON()
toString()

/* Listener registration methods.  They work the same as on Firebase objects, except that the
   snapshot passed into the callback (and forEach) is wrapped such that:
     1) The val() method will return a normalized method (like NodeFire.get() does).
     2) The ref() method will return a NodeFire reference, with the same scope as the reference
        on which on() was called.
     3) The child() method takes an optional extra scope parameter, just like NodeFire.child().
*/
on(eventType, callback, cancelCallback, context)
off(eventType, callback, context)

/* Query methods which work the same as in the Firebase Admin SDK. */
limitToFirst(limit)
limitToLast(limit)
startAt(value, key)
endAt(value, key)
equalTo(value, key)
orderByChild(path)
orderByKey()
orderByValue()
```
