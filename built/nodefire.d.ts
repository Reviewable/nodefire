export = NodeFire;
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
declare class NodeFire {
    /**
     * Returns a placeholder value for auto-populating the current timestamp (time since the Unix
     * epoch, in milliseconds) as determined by the Firebase servers.
     * @return {Object} A timestamp placeholder value.
     */
    static get SERVER_TIMESTAMP(): any;
    /**
     * Turns Firebase low-level connection logging on or off.
     * @param {boolean} enable Whether to enable or disable logging.
     */
    static enableFirebaseLogging(enable: boolean): void;
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
    static interceptOperations(callback: interceptOperationsCallback): void;
    /**
     * Sets the maximum number of values to keep pinned and updated in the cache.  The cache is not
     * used unless you set a non-zero maximum.
     * @param {number} max The maximum number of values to keep pinned in the cache.
     */
    static setCacheSize(max: number): void;
    /**
     * Sets the maximum number of pinned values to retain in the cache when an app gets disconnected.
     * By default all values are retained, but if your cache size is high they'll all need to be
     * double-checked against the Firebase server when the connection comes back.  It may thus be more
     * economical to drop the least used ones when disconnected.
     * @param {number} max The maximum number of values from a disconnected app to keep pinned in the
     *        cache.
     */
    static setCacheSizeForDisconnectedApp(max: number): void;
    /**
     * Gets the current number of values pinned in the cache.
     * @return {number} The current size of the cache.
     */
    static getCacheCount(): number;
    /**
     * Gets the current cache hit rate.  This is very approximate, as it's only counted for get() and
     * transaction() calls, and is unable to count ancestor hits, where the ancestor of the requested
     * item is actually cached.
     * @return {number} The cache's current hit rate.
     */
    static getCacheHitRate(): number;
    /**
     * Resets the cache's hit rate counters back to zero.
     */
    static resetCacheHitRate(): void;
    /**
     * Escapes a string to make it an acceptable Firebase key.
     * @param {string} key The proposed key to escape.
     * @return {string} The escaped key.
     */
    static escape(key: string): string;
    /**
     * Unescapes a previously escaped (or interpolated) key.
     * @param {string} key The key to unescape.
     * @return {string} The original unescaped key.
     */
    static unescape(key: string): string;
    /**
     * Creates a new NodeFire wrapper around a raw Firebase Admin reference.
     *
     * @param {admin.database.Query} ref A fully authenticated Firebase Admin reference or query.
     * @param {Object} scope Optional dictionary that will be used for interpolating paths.
     */
    constructor(ref: import("firebase-admin/lib/database").admin.database.Query, scope: any);
    $ref: import("firebase-admin/lib/database").admin.database.Query;
    $scope: any;
    /**
     * @private
     */
    private _path;
    /**
     * Returns the database instance corresponding to this reference.
     * @return {admin.database.Database} The database instance corresponding to this reference.
     */
    get database(): import("firebase-admin/lib/database").admin.database.Database;
    /**
     * Returns the last part of this reference's path. The key of a root reference is `null`.
     * @return {string|null} The last part this reference's path.
     */
    get key(): string;
    /**
     * Returns just the path component of the reference's URL.
     * @return {string} The path component of the Firebase URL wrapped by this NodeFire object.
     */
    get path(): string;
    /**
     * Returns a NodeFire reference at the same location as this query or reference.
     * @return {NodeFire|null} A NodeFire reference at the same location as this query or reference.
     */
    get ref(): import("./nodefire");
    /**
     * Returns a NodeFire reference to the root of the database.
     * @return {NodeFire} The root reference of the database.
     */
    get root(): import("./nodefire");
    /**
     * Returns a NodeFire reference to the parent location of this reference. The parent of a root
     * reference is `null`.
     * @return {NodeFire|null} The parent location of this reference.
     */
    get parent(): import("./nodefire");
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
    interpolate(string: string, scope: any): string;
    /**
     * Returns a JSON-serializable representation of this object.
     * @return {Object} A JSON-serializable representation of this object.
     */
    toJSON(): any;
    /**
     * Returns whether or not this NodeFire instance is equivalent to the provided NodeFire instance.
     * @param {Nodefire} otherRef Another NodeFire instance against which to compare.
     * @return {boolean}
     */
    isEqual(otherRef: any): boolean;
    /**
     * Stringifies the wrapped reference.
     * @return {string} The Firebase URL wrapped by this NodeFire object.
     */
    toString(): string;
    /**
     * Creates a new NodeFire object on the same reference, but with an extended interpolation scope.
     * @param  {Object} scope A dictionary of interpolation variables that will be added to (and take
     *     precedence over) the one carried by this NodeFire object.
     * @return {NodeFire} A new NodeFire object with the same reference and new scope.
     */
    scope(scope: any): NodeFire;
    /**
     * Creates a new NodeFire object on a child of this one, and optionally an augmented scope.
     * @param  {string} path The path to the desired child, relative to this reference.  The path will
     *     be interpolated using this object's scope and the additional scope provided.  For the
     *     syntax see the interpolate() method.
     * @param  {Object} scope Optional additional scope that will add to (and override) this object's
     *     scope.
     * @return {NodeFire} A new NodeFire object on the child reference, and with the augmented scope.
     */
    child(path: string, scope: any): NodeFire;
    /**
     * Gets this reference's current value from Firebase, and inserts it into the cache if a
     * maxCacheSize was set and the `cache` option is not false.
     * @param {{timeout?: number?, cache?: boolean?}} options
     * @return {Promise} A promise that is resolved to the reference's value, or rejected with an
     *     error.  The value returned is normalized, meaning arrays are converted to objects.
     */
    get(options: {
        timeout?: number | null;
        cache?: boolean | null;
    }): Promise<any>;
    /**
     * Adds this reference to the cache (if maxCacheSize set) and counts a cache hit or miss.
     */
    cache(): void;
    /**
     * Removes this reference from the cache (if maxCacheSize is set).
     * @return True if the reference was cached, false otherwise.
     */
    uncache(): boolean;
    /**
     * Sets the value at this reference.
     * @param {Object || number || string || boolean} value The value to set.
     * @param {{timeout?: number?}=} options
     * @returns {Promise<void>} A promise that is resolved when the value has been set,
     * or rejected with an error.
     */
    set(value: any, options?: {
        timeout?: number | null;
    }): Promise<void>;
    /**
     * Updates a value at this reference, setting only the top-level keys supplied and leaving any
     * other ones as-is.
     * @param  {Object} value The value to update the reference with.
     * @param {{timeout?: number?}=} options
     * @return {Promise<void>} A promise that is resolved when the value has been updated,
     * or rejected with an error.
     */
    update(value: any, options?: {
        timeout?: number | null;
    }): Promise<void>;
    /**
     * Removes this reference from the Firebase.
     * @return {Promise} A promise that is resolved when the value has been removed, or rejected with
     *     an error.
     */
    remove(options: any): Promise<any>;
    /**
     * Pushes a value as a new child of this reference, with a new unique key.  Note that if you just
     * want to generate a new unique key you can call newKey() directly.
     * @param  {Object || number || string || boolean} value The value to push.
     * @return {Promise} A promise that is resolved to a new NodeFire object that refers to the newly
     *     pushed value (with the same scope as this object), or rejected with an error.
     */
    push(value: any, options: any): Promise<any>;
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
    transaction(updateFunction: (arg0: any) => any, options: {
        detectStuck?: boolean | null;
        prefetchValue?: boolean | null;
        timeout?: number | null;
    }): Promise<any>;
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
    on(eventType: any, callback: (Snapshot: any) => Snapshot, cancelCallback: () => void, context: any): (Snapshot: any) => Snapshot;
    /**
     * Unregisters a listener.  Works the same as the Firebase method.
     */
    off(eventType: any, callback: any, context: any): void;
    /**
     * Generates a unique string that can be used as a key in Firebase.
     * @return {string} A unique string that satisfies Firebase's key syntax constraints.
     */
    newKey(): string;
    /**
     * Returns the current timestamp after adjusting for the Firebase-computed server time offset.
     * @return {number} The current time in integer milliseconds since the epoch.
     */
    get now(): number;
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
    childrenKeys(options?: {
        maxTries?: number | null;
        retryInterval?: number | null;
        agent?: any;
    }, ...args: any[]): Promise<string[]>;
    /**
     * Turns debugging of permission denied errors on and off for the database this ref is attached
     * to.  When turned on, permission denied errors will have an additional permissionTrace property
     * with a human-readable description of which security rules failed.  There's no performance
     * penalty to turning this on until a permission actually gets denied.
     * @param {string} legacySecret A legacy database secret, needed to access the old API that allows
     *     simulating request with debug feedback.  Pass a falsy value to turn off debugging.
     */
    enablePermissionDebugging(legacySecret: string): void;
}
declare namespace NodeFire {
    export { LOG_TRANSACTIONS, Snapshot as SnapShot, interceptOperationsCallback };
}
/**
  A wrapper around a Firebase DataSnapshot.  Works just like a Firebase snapshot, except that
  ref returns a NodeFire instance, val() normalizes the value, and child() takes an optional
  refining scope.
 */
declare class Snapshot {
    constructor(snap: any, nodeFire: any);
    $snap: any;
    $nodeFire: any;
    get key(): any;
    get ref(): import("./nodefire");
    val(): any;
    child(path: any, scope: any): Snapshot;
    forEach(callback: any): void;
}
/**
 * This callback type is called `requestCallback` and is displayed as a global symbol.
 */
type interceptOperationsCallback = (op: {
    ref: NodeFire;
    method: string;
    args: any[];
}, options: any) => Promise<void> | void;
declare var LOG_TRANSACTIONS: boolean;
