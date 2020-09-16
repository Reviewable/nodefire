'use strict';
var __spreadArrays = (this && this.__spreadArrays) || function () {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};
var admin = require('firebase-admin');
var _ = require('lodash');
var LRUCache = require('lru-cache');
var firebaseChildrenKeys = require('firebase-childrenkeys');
var firefight = require('firefight');
var timers = require('safe-timers');
var cache, cacheHits = 0, cacheMisses = 0, maxCacheSizeForDisconnectedApp = Infinity;
var serverTimeOffsets = {}, serverDisconnects = {}, simulators = {};
var operationInterceptors = [];
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
var NodeFire = /** @class */ (function () {
    // jshint latedef:nofunc
    /**
     * Creates a new NodeFire wrapper around a raw Firebase Admin reference.
     *
     * @param {admin.database.Query} ref A fully authenticated Firebase Admin reference or query.
     * @param {Object} scope Optional dictionary that will be used for interpolating paths.
     */
    function NodeFire(ref, scope) {
        var refIsNonNullObject = typeof ref === 'object' && ref !== null;
        if (!refIsNonNullObject || typeof ref.ref !== 'object' ||
            typeof ref.ref.transaction !== 'function') {
            throw new Error("Expected first argument passed to NodeFire constructor to be a Firebase Database reference,\n        but got \"" + ref + "\".");
        }
        this.$ref = ref;
        this.$scope = scope || {};
        /**
         * @private
         */
        this._path = undefined; // initialized lazily
        trackTimeOffset(this);
        trackDisconnect(this);
    }
    Object.defineProperty(NodeFire, "SERVER_TIMESTAMP", {
        /**
         * Returns a placeholder value for auto-populating the current timestamp (time since the Unix
         * epoch, in milliseconds) as determined by the Firebase servers.
         * @return {Object} A timestamp placeholder value.
         */
        get: function () {
            return {
                '.sv': 'timestamp'
            };
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(NodeFire.prototype, "database", {
        /**
         * Returns the database instance corresponding to this reference.
         * @return {admin.database.Database} The database instance corresponding to this reference.
         */
        get: function () {
            return this.$ref.ref.database;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(NodeFire.prototype, "key", {
        /**
         * Returns the last part of this reference's path. The key of a root reference is `null`.
         * @return {string|null} The last part this reference's path.
         */
        get: function () {
            return this.$ref.ref.key;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(NodeFire.prototype, "path", {
        /**
         * Returns just the path component of the reference's URL.
         * @return {string} The path component of the Firebase URL wrapped by this NodeFire object.
         */
        get: function () {
            if (!this._path) {
                this._path =
                    decodeURIComponent(this.$ref.toString()).slice(this.$ref.ref.root.toString().length - 1);
            }
            return this._path;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(NodeFire.prototype, "ref", {
        /**
         * Returns a NodeFire reference at the same location as this query or reference.
         * @return {NodeFire|null} A NodeFire reference at the same location as this query or reference.
         */
        get: function () {
            if (this.$ref.isEqual(this.$ref.ref))
                return this;
            return new NodeFire(this.$ref.ref, this.$scope);
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(NodeFire.prototype, "root", {
        /**
         * Returns a NodeFire reference to the root of the database.
         * @return {NodeFire} The root reference of the database.
         */
        get: function () {
            if (this.$ref.isEqual(this.$ref.ref.root))
                return this;
            return new NodeFire(this.$ref.ref.root, this.$scope);
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(NodeFire.prototype, "parent", {
        /**
         * Returns a NodeFire reference to the parent location of this reference. The parent of a root
         * reference is `null`.
         * @return {NodeFire|null} The parent location of this reference.
         */
        get: function () {
            if (this.$ref.ref.parent === null)
                return null;
            return new NodeFire(this.$ref.ref.parent, this.$scope);
        },
        enumerable: false,
        configurable: true
    });
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
    NodeFire.prototype.interpolate = function (string, scope) {
        scope = scope ? _.assign(_.clone(this.$scope), scope) : this.$scope;
        string = string.replace(/:([a-z-_]+)|\{(.+?)\}/gi, function (match, v1, v2) {
            var v = (v1 || v2);
            var parts = v.split('.');
            var value = scope;
            for (var i = 0; i < parts.length; i++) {
                value = value[parts[i]];
                if (_.isNil(value)) {
                    throw new Error('Missing or null variable "' + v + '" when expanding NodeFire path "' + string + '"');
                }
            }
            return NodeFire.escape(value);
        });
        return string;
    };
    // TODO: add onDisconnect
    // TODO: add user/password-related methods
    /**
     * Returns a JSON-serializable representation of this object.
     * @return {Object} A JSON-serializable representation of this object.
     */
    NodeFire.prototype.toJSON = function () {
        return this.$ref.toJSON();
    };
    /**
     * Returns whether or not this NodeFire instance is equivalent to the provided NodeFire instance.
     * @param {Nodefire} otherRef Another NodeFire instance against which to compare.
     * @return {boolean}
     */
    NodeFire.prototype.isEqual = function (otherRef) {
        return this.$ref.isEqual(otherRef.$ref);
    };
    /**
     * Stringifies the wrapped reference.
     * @return {string} The Firebase URL wrapped by this NodeFire object.
     */
    NodeFire.prototype.toString = function () {
        return decodeURIComponent(this.$ref.toString());
    };
    /**
     * Creates a new NodeFire object on the same reference, but with an extended interpolation scope.
     * @param  {Object} scope A dictionary of interpolation variables that will be added to (and take
     *     precedence over) the one carried by this NodeFire object.
     * @return {NodeFire} A new NodeFire object with the same reference and new scope.
     */
    NodeFire.prototype.scope = function (scope) {
        return new NodeFire(this.$ref, _.assign(_.clone(this.$scope), scope));
    };
    /**
     * Creates a new NodeFire object on a child of this one, and optionally an augmented scope.
     * @param  {string} path The path to the desired child, relative to this reference.  The path will
     *     be interpolated using this object's scope and the additional scope provided.  For the
     *     syntax see the interpolate() method.
     * @param  {Object} scope Optional additional scope that will add to (and override) this object's
     *     scope.
     * @return {NodeFire} A new NodeFire object on the child reference, and with the augmented scope.
     */
    NodeFire.prototype.child = function (path, scope) {
        var child = this.scope(scope);
        return new NodeFire(this.$ref.child(child.interpolate(path)), child.$scope);
    };
    /**
     * Gets this reference's current value from Firebase, and inserts it into the cache if a
     * maxCacheSize was set and the `cache` option is not false.
     * @param {{timeout?: number?, cache?: boolean?}} options
     * @return {Promise} A promise that is resolved to the reference's value, or rejected with an
     *     error.  The value returned is normalized, meaning arrays are converted to objects.
     */
    NodeFire.prototype.get = function (options) {
        var _this = this;
        return invoke({ ref: this, method: 'get', args: [] }, options, function (opts) {
            if (opts.cache === undefined || opts.cache)
                _this.cache();
            return _this.$ref.once('value').then(function (snap) { return getNormalValue(snap); });
        });
    };
    /**
     * Adds this reference to the cache (if maxCacheSize set) and counts a cache hit or miss.
     */
    NodeFire.prototype.cache = function () {
        if (!cache)
            return;
        var key = this.database.app.name + '/' + this.path;
        if (cache.has(key)) {
            cacheHits++;
        }
        else {
            cacheMisses++;
            cache.set(key, this);
            this.$ref.on('value', noopCallback, function () {
                if (cache)
                    cache.del(key);
            });
        }
    };
    /**
     * Removes this reference from the cache (if maxCacheSize is set).
     * @return True if the reference was cached, false otherwise.
     */
    NodeFire.prototype.uncache = function () {
        if (!cache)
            return;
        var key = this.database.app.name + '/' + this.path;
        if (!cache.has(key))
            return false;
        cache.del(key);
        return true;
    };
    /**
     * Sets the value at this reference.
     * @param {Object || number || string || boolean} value The value to set.
     * @param {{timeout?: number?}=} options
     * @returns {Promise<void>} A promise that is resolved when the value has been set,
     * or rejected with an error.
     */
    NodeFire.prototype.set = function (value, options) {
        var _this = this;
        return invoke({ ref: this, method: 'set', args: [value] }, options, function (opts) { return _this.$ref.set(value); });
    };
    /**
     * Updates a value at this reference, setting only the top-level keys supplied and leaving any
     * other ones as-is.
     * @param  {Object} value The value to update the reference with.
     * @param {{timeout?: number?}=} options
     * @return {Promise<void>} A promise that is resolved when the value has been updated,
     * or rejected with an error.
     */
    NodeFire.prototype.update = function (value, options) {
        var _this = this;
        return invoke({ ref: this, method: 'update', args: [value] }, options, function (opts) { return _this.$ref.update(value); });
    };
    /**
     * Removes this reference from the Firebase.
     * @return {Promise} A promise that is resolved when the value has been removed, or rejected with
     *     an error.
     */
    NodeFire.prototype.remove = function (options) {
        var _this = this;
        return invoke({ ref: this, method: 'remove', args: [] }, options, function (opts) { return _this.$ref.remove(); });
    };
    /**
     * Pushes a value as a new child of this reference, with a new unique key.  Note that if you just
     * want to generate a new unique key you can call newKey() directly.
     * @param  {Object || number || string || boolean} value The value to push.
     * @return {Promise} A promise that is resolved to a new NodeFire object that refers to the newly
     *     pushed value (with the same scope as this object), or rejected with an error.
     */
    NodeFire.prototype.push = function (value, options) {
        var _this = this;
        if (value === undefined || value === null) {
            return new NodeFire(this.$ref.push(), this.$scope);
        }
        return invoke({ ref: this, method: 'push', args: [value] }, options, function (opts) {
            var ref = _this.$ref.push(value);
            return ref.then(function () { return new NodeFire(ref, _this.$scope); });
        });
    };
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
     * @param  {{detectStuck?: boolean?, prefetchValue?: boolean?, timeout?: number?}} options An
     * options objects that may include the following properties:
     *     {number} detectStuck Throw a 'stuck' exception after the update function's input value has
     *         remained unchanged this many times.  Defaults to 0 (turned off).
     *     {boolean} prefetchValue Fetch and keep pinned the value referenced by the transaction while
     *         the transaction is in progress.  Defaults to true.
     *     {number} timeout A number of milliseconds after which to time out the transaction and
     *         reject the promise with 'timeout'.
     * @return {Promise} A promise that is resolved with the (normalized) committed value if the
     *     transaction committed or with undefined if it aborted, or rejected with an error.
     */
    NodeFire.prototype.transaction = function (updateFunction, options) {
        var self = this; // easier than using => functions or binding explicitly
        var tries = 0, result;
        var startTime = self.now;
        var prefetchDoneTime;
        var metadata = {};
        options = options || {};
        function fillMetadata(outcome) {
            if (metadata.outcome)
                return;
            metadata.outcome = outcome;
            metadata.tries = tries;
            if (prefetchDoneTime) {
                metadata.prefetchDuration = prefetchDoneTime - startTime;
                metadata.duration = self.now - prefetchDoneTime;
            }
            else {
                metadata.duration = self.now - startTime;
            }
        }
        var op = { ref: this, method: 'transaction', args: [updateFunction] };
        return Promise.all(_.map(operationInterceptors, function (interceptor) { return Promise.resolve(interceptor(op, options)); })).then(function () {
            var promise = new Promise(function (resolve, reject) {
                var wrappedRejectNoResult = wrapReject(self, 'transaction', reject);
                var wrappedReject = wrappedRejectNoResult;
                var aborted, settled;
                var inputValues = [];
                var numConsecutiveEqualInputValues = 0;
                function wrappedUpdateFunction(value) {
                    try {
                        wrappedReject = wrappedRejectNoResult;
                        if (aborted)
                            return; // transaction otherwise aborted and promise settled, just stop
                        if (options.detectStuck) {
                            if (inputValues.length && _.isEqual(value, _.last(inputValues))) {
                                numConsecutiveEqualInputValues++;
                            }
                            else {
                                numConsecutiveEqualInputValues = 0;
                                inputValues.push(_.cloneDeep(value));
                            }
                            if (numConsecutiveEqualInputValues >= options.detectStuck) {
                                var error = new Error('stuck');
                                error.inputValues = inputValues;
                                throw error;
                            }
                        }
                        if (++tries > 25)
                            throw new Error('maxretry');
                        result = updateFunction(getNormalRawValue(value));
                        wrappedReject = wrapReject(self, 'transaction', result, reject);
                        return result;
                    }
                    catch (e) {
                        // Firebase propagates exceptions thrown by the update function to the top level.  So
                        // catch them here instead, reject the promise, and abort the transaction by returning
                        // undefined.  The callback will then try to resolve the promise (seeing an uncommitted
                        // transaction with no error) but it'll be a no-op.
                        fillMetadata('error');
                        wrappedReject(e);
                    }
                }
                var onceTxn, timeout;
                function txn() {
                    if (!prefetchDoneTime)
                        prefetchDoneTime = self.now;
                    try {
                        self.$ref.transaction(wrappedUpdateFunction, function (error, committed, snap) {
                            if (error && (error.message === 'set' || error.message === 'disconnect')) {
                                txn();
                                return;
                            }
                            settled = true;
                            if (timeout)
                                timeout.clear();
                            if (onceTxn)
                                self.$ref.off('value', onceTxn);
                            fillMetadata(error ? 'error' : (committed ? 'commit' : 'skip'));
                            if (NodeFire.LOG_TRANSACTIONS) {
                                console.log(JSON.stringify({ txn: {
                                        tries: tries,
                                        path: self.toString().replace(/https:\/\/[^/]*/, ''),
                                        outcome: metadata.outcome, value: result
                                    } }));
                            }
                            if (error) {
                                wrappedReject(error);
                            }
                            else if (committed) {
                                resolve(getNormalValue(snap));
                            }
                            else {
                                resolve();
                            }
                        }, false).catch(noopCallback);
                    }
                    catch (e) {
                        wrappedReject(e);
                    }
                }
                if (options.timeout) {
                    timeout = timers.setTimeout(function () {
                        if (settled)
                            return;
                        aborted = true;
                        var e = new Error('timeout');
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
                }
                else {
                    txn();
                }
            });
            promise.transaction = metadata;
            return promise;
        });
    };
    /**
     * Registers a listener for an event on this reference.  Works the same as the Firebase method
     * except that the snapshot passed into the callback will be wrapped such that:
     *   1) The val() method will return a normalized method (like NodeFire.get() does).
     *   2) The ref() method will return a NodeFire reference, with the same scope as the reference
     *      on which on() was called.
     *   3) The child() method takes an optional extra scope parameter, just like NodeFire.child().
     * @param {(Snapshot) => Snapshot} callback
     * @param {() => void} cancelCallback
     * @param {any} context
     */
    NodeFire.prototype.on = function (eventType, callback, cancelCallback, context) {
        cancelCallback = wrapReject(this, 'on', cancelCallback);
        this.$ref.on(eventType, captureCallback(this, eventType, callback), cancelCallback, context);
        return callback;
    };
    /**
     * Unregisters a listener.  Works the same as the Firebase method.
     */
    NodeFire.prototype.off = function (eventType, callback, context) {
        this.$ref.off(eventType, callback && popCallback(this, eventType, callback), context);
    };
    /**
     * Generates a unique string that can be used as a key in Firebase.
     * @return {string} A unique string that satisfies Firebase's key syntax constraints.
     */
    NodeFire.prototype.newKey = function () {
        return this.$ref.push().key;
    };
    Object.defineProperty(NodeFire.prototype, "now", {
        /**
         * Returns the current timestamp after adjusting for the Firebase-computed server time offset.
         * @return {number} The current time in integer milliseconds since the epoch.
         */
        get: function () {
            return new Date().getTime() + serverTimeOffsets[this.database.app.name];
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Fetches the keys of the current reference's children without also fetching all the contents,
     * using the Firebase REST API.
     *
     * @param {{maxTries?: number?, retryInterval?: number?, agent?: http.Agent?}=} options An options
     * object with the following items, all optional:
     *   - maxTries: the maximum number of times to try to fetch the keys, in case of transient errors
     *               (defaults to 1)
     *   - retryInterval: the number of milliseconds to delay between retries (defaults to 1000)
     *   - agent:
     * @return {Promise<string[]>} A promise that resolves to an array of key strings.
     */
    NodeFire.prototype.childrenKeys = function (options) {
        var _a;
        return this.$ref.childrenKeys ? (_a = this.$ref).childrenKeys.apply(_a, arguments) : firebaseChildrenKeys.apply(void 0, __spreadArrays([this.$ref], arguments));
    };
    /**
     * Turns Firebase low-level connection logging on or off.
     * @param {boolean} enable Whether to enable or disable logging.
     */
    NodeFire.enableFirebaseLogging = function (enable) {
        admin.database.enableLogging(enable);
    };
    /**
     * Turns debugging of permission denied errors on and off for the database this ref is attached
     * to.  When turned on, permission denied errors will have an additional permissionTrace property
     * with a human-readable description of which security rules failed.  There's no performance
     * penalty to turning this on until a permission actually gets denied.
     * @param {string} legacySecret A legacy database secret, needed to access the old API that allows
     *     simulating request with debug feedback.  Pass a falsy value to turn off debugging.
     */
    NodeFire.prototype.enablePermissionDebugging = function (legacySecret) {
        if (legacySecret) {
            if (!simulators[this.database.app.name]) {
                var authOverride = this.database.app.options.databaseAuthVariableOverride;
                if (!authOverride || !authOverride.uid) {
                    throw new Error('You must initialize your database with a databaseAuthVariableOverride that includes ' +
                        'a uid');
                }
                simulators[this.database.app.name] = new firefight.Simulator(this.database, legacySecret);
            }
        }
        else {
            delete simulators[this.database.app.name];
        }
    };
    /**
     * Adds an intercepting callback before all NodeFire database operations.  This callback can
     * modify the operation's options or block it while performing other work.
     * @param {interceptOperationsCallback} callback
     *     The callback to invoke before each operation.  It will be passed two
     *     arguments: an operation descriptor ({ref, method, args}) and an options object.  The
     *     descriptor is read-only but the options can be modified.  The callback can return any value
     *     (which will be ignored) or a promise, to block execution of the operation (but not other
     *     interceptors) until the promise settles.
     */
    NodeFire.interceptOperations = function (callback) {
        operationInterceptors.push(callback);
    };
    /**
     * Sets the maximum number of values to keep pinned and updated in the cache.  The cache is not
     * used unless you set a non-zero maximum.
     * @param {number} max The maximum number of values to keep pinned in the cache.
     */
    NodeFire.setCacheSize = function (max) {
        if (max) {
            if (cache) {
                cache.max = max;
            }
            else {
                cache = new LRUCache({ max: max, dispose: function (key, ref) {
                        ref.$ref.off('value', noopCallback);
                    } });
            }
        }
        else {
            if (cache)
                cache.reset();
            cache = null;
        }
    };
    /**
     * Sets the maximum number of pinned values to retain in the cache when an app gets disconnected.
     * By default all values are retained, but if your cache size is high they'll all need to be
     * double-checked against the Firebase server when the connection comes back.  It may thus be more
     * economical to drop the least used ones when disconnected.
     * @param {number} max The maximum number of values from a disconnected app to keep pinned in the
     *        cache.
     */
    NodeFire.setCacheSizeForDisconnectedApp = function (max) {
        maxCacheSizeForDisconnectedApp = max;
    };
    /**
     * Gets the current number of values pinned in the cache.
     * @return {number} The current size of the cache.
     */
    NodeFire.getCacheCount = function () {
        return cache ? cache.itemCount : 0;
    };
    /**
     * Gets the current cache hit rate.  This is very approximate, as it's only counted for get() and
     * transaction() calls, and is unable to count ancestor hits, where the ancestor of the requested
     * item is actually cached.
     * @return {number} The cache's current hit rate.
     */
    NodeFire.getCacheHitRate = function () {
        return (cacheHits || cacheMisses) ? cacheHits / (cacheHits + cacheMisses) : 0;
    };
    /**
     * Resets the cache's hit rate counters back to zero.
     */
    NodeFire.resetCacheHitRate = function () {
        cacheHits = cacheMisses = 0;
    };
    /**
     * Escapes a string to make it an acceptable Firebase key.
     * @param {string} key The proposed key to escape.
     * @return {string} The escaped key.
     */
    NodeFire.escape = function (key) {
        // eslint-disable-next-line no-control-regex
        return key.toString().replace(/[\x00-\x1f\\.$#[\]\x7f/]/g, function (char) {
            return '\\' + _.padStart(char.charCodeAt(0).toString(16), 2, '0');
        });
    };
    /**
     * Unescapes a previously escaped (or interpolated) key.
     * @param {string} key The key to unescape.
     * @return {string} The original unescaped key.
     */
    NodeFire.unescape = function (key) {
        return key.toString().replace(/\\[0-9a-f]{2}/gi, function (code) {
            return String.fromCharCode(parseInt(code.slice(1), 16));
        });
    };
    return NodeFire;
}());
/**
 * This callback type is called `requestCallback` and is displayed as a global symbol.
 *
 * @callback interceptOperationsCallback
 * @param {{ref: NodeFire, method: string, args: any[]}} op
 * @param {any} options
 * @return {Promise<void> | void}
 */
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
var Snapshot = /** @class */ (function () {
    function Snapshot(snap, nodeFire) {
        this.$snap = snap;
        this.$nodeFire = nodeFire;
    }
    Object.defineProperty(Snapshot.prototype, "key", {
        get: function () {
            return this.$snap.key;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(Snapshot.prototype, "ref", {
        get: function () {
            return new NodeFire(this.$snap.ref, this.$nodeFire.$scope);
        },
        enumerable: false,
        configurable: true
    });
    Snapshot.prototype.val = function () {
        return getNormalValue(this.$snap);
    };
    Snapshot.prototype.child = function (path, scope) {
        var childNodeFire = this.$nodeFire.scope(scope);
        return new Snapshot(this.$snap.child(childNodeFire.interpolate(path)), childNodeFire);
    };
    Snapshot.prototype.forEach = function (callback) {
        var _this = this;
        this.$snap.forEach(function (child) {
            return callback(new Snapshot(child, _this.$nodeFire));
        });
    };
    return Snapshot;
}());
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
    var key = eventType + '::' + nodeFire.toString();
    callback.$nodeFireCallbacks = callback.$nodeFireCallbacks || {};
    callback.$nodeFireCallbacks[key] = callback.$nodeFireCallbacks[key] || [];
    var nodeFireCallback = function (snap, previousChildKey) {
        // eslint-disable-next-line no-invalid-this
        runGenerator(callback.call(this, new Snapshot(snap, nodeFire), previousChildKey));
    };
    callback.$nodeFireCallbacks[key].push(nodeFireCallback);
    return nodeFireCallback;
}
function popCallback(nodeFire, eventType, callback) {
    var key = eventType + '::' + nodeFire.toString();
    return callback.$nodeFireCallbacks[key].pop();
}
function runGenerator(o) {
    var promise;
    if (o instanceof Promise) {
        promise = o;
    }
    else if (o && typeof o.next === 'function' && typeof o.throw === 'function' && Promise.co) {
        promise = Promise.co(o);
    }
    if (promise)
        promise.catch(function (error) { throw error; });
}
function wrapNodeFire(method) {
    NodeFire.prototype[method] = function () {
        return new NodeFire(this.$ref[method].apply(this.$ref, arguments), this.$scope);
    };
}
function delegateSnapshot(method) {
    Snapshot.prototype[method] = function () {
        return this.$snap[method].apply(this.$snap, arguments);
    };
}
function wrapReject(nodefire, method, value, reject) {
    var hasValue = true;
    if (!reject) {
        reject = value;
        hasValue = false;
    }
    if (!reject)
        return reject;
    return function (error) {
        handleError(error, { ref: nodefire, method: method, args: hasValue ? [value] : [] }, reject);
    };
}
function noopCallback() { }
function trackTimeOffset(ref, recover) {
    var appName = ref.database.app.name;
    if (!recover) {
        if (appName in serverTimeOffsets)
            return;
        serverTimeOffsets[appName] = 0;
    }
    ref.root.child('.info/serverTimeOffset').on('value', function (snap) {
        serverTimeOffsets[appName] = snap.val();
    }, _.bind(trackTimeOffset, ref, true));
}
function trackDisconnect(ref, recover) {
    var appName = ref.database.app.name;
    if (!recover && serverDisconnects[appName])
        return;
    serverDisconnects[appName] = true;
    ref.root.child('.info/connected').on('value', function (snap) {
        if (!snap.val())
            trimCache(ref);
    }, _.bind(trackDisconnect, ref, true));
}
function trimCache(ref) {
    if (!cache || cache.max <= maxCacheSizeForDisconnectedApp)
        return;
    var prefix = ref.database.app.name + '/';
    var count = 0;
    cache.forEach(function (value, key) {
        if (key.slice(0, prefix.length) !== prefix)
            return;
        if (++count <= maxCacheSizeForDisconnectedApp)
            return;
        cache.del(key);
    });
}
function getNormalValue(snap) {
    return getNormalRawValue(snap.val());
}
function getNormalRawValue(value) {
    if (_.isArray(value)) {
        var normalValue_1 = {};
        _.forEach(value, function (item, key) {
            if (!_.isNil(item)) {
                normalValue_1[key] = getNormalRawValue(item);
            }
        });
        value = normalValue_1;
    }
    else if (_.isObject(value)) {
        _.forEach(value, function (item, key) {
            value[key] = getNormalRawValue(item);
        });
    }
    return value;
}
function invoke(op, options, fn) {
    if (options === void 0) { options = {}; }
    return Promise.all(_.map(operationInterceptors, function (interceptor) { return Promise.resolve(interceptor(op, options)); })).then(function () {
        var promises = [];
        var timeout, settled;
        if (options.timeout) {
            promises.push(new Promise(function (resolve, reject) {
                timeout = timers.setTimeout(function () {
                    if (!settled)
                        reject(new Error('timeout'));
                }, options.timeout);
            }));
        }
        promises.push(Promise.resolve(fn(options)).then(function (result) {
            settled = true;
            if (timeout)
                timeout.clear();
            return result;
        }));
        return Promise.race(promises).catch(function (e) {
            settled = true;
            if (timeout)
                timeout.clear();
            if (e.message === 'timeout')
                e.timeout = options.timeout;
            return handleError(e, op, Promise.reject.bind(Promise));
        });
    });
}
function handleError(error, op, callback) {
    var args = _.map(op.args, function (arg) { return _.isFunction(arg) ? "<function" + (arg.name ? ' ' + arg.name : '') + ">" : arg; });
    var argsString = JSON.stringify(args);
    if (argsString.length > 500)
        args = argsString.slice(0, 500) + '...';
    error.firebase = {
        ref: op.ref.toString(), method: op.method,
        args: args,
        code: (error.code || error.message || '').toLowerCase() || undefined
    };
    if (error.message === 'timeout' && error.timeout) {
        error.firebase.timeout = error.timeout;
        delete error.timeout;
    }
    if (error.message === 'stuck' && error.inputValues) {
        error.firebase.inputValues = error.inputValues;
        delete error.inputValues;
    }
    if (!error.code)
        error.code = error.message;
    error.message = 'Firebase: ' + error.message;
    var simulator = simulators[op.ref.database.app.name];
    if (!simulator || !simulator.isPermissionDenied(error))
        return callback(error);
    var method = op.method === 'get' ? 'once' : op.method;
    var authOverride = op.ref.database.app.options.databaseAuthVariableOverride;
    return simulator.auth(authOverride)[method](op.ref, op.args[0]).then(function (explanation) {
        error.firebase.permissionTrace = explanation;
        return callback(error);
    });
}
module.exports = NodeFire;
module.exports.SnapShot = Snapshot;
