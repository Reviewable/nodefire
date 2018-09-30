const _ = require('lodash');
const assert = require('assert');

const admin = require('./loadFirebase');
const NodeFire = require('../nodefire.js');

console.log(`[INFO] Running tests...`)

const db = admin.database();
const rootRef = new NodeFire(db.ref());
const fooRef = rootRef.child('foo');
const barRef = fooRef.child('bar');
const barQueryRef = barRef.startAt('a').endAt('b').orderByKey().limitToFirst(10);
const randomRef = rootRef.push();

assert(barRef.database === db, `barRef.database should equal the original database instance`);
assert(barQueryRef.database === db, `barQueryRef.database should equal the original database instance`);

assert(rootRef.key === null, `rootRef.key should be null`);
assert(rootRef.parent === null, `rootRef.parent should be null`);

assert(fooRef.key === 'foo', `fooRef.key should be 'foo'`);
assert(fooRef.parent.key === null, `fooRef.key.parent.key should be null`);
assert(rootRef.isEqual(fooRef.parent), `rootRef.isEqual(fooRef.parent) should be true`);

assert(barRef.key === 'bar', `barRef.key should be 'bar'`);
assert(barQueryRef.key === 'bar', `barQueryRef.key should be 'bar'`);
assert(barRef.parent.key === 'foo', `barRef.parent.key should be 'foo'`);
assert(barQueryRef.parent.key === 'foo', `barQueryRef.parent.key should be 'foo'`);
assert(!rootRef.isEqual(barRef.parent), `rootRef.isEqual(barRef.parent) should be false`);
assert(!rootRef.isEqual(barQueryRef.parent), `rootRef.isEqual(barQueryRef.parent) should be false`);
assert(fooRef.isEqual(barRef.parent), `fooRef.isEqual(barRef.parent) should be true`);
assert(fooRef.isEqual(barQueryRef.parent), `fooRef.isEqual(barQueryRef.parent) should be true`);
assert(rootRef.isEqual(barRef.parent.parent), `rootRef.isEqual(barRef.parent.parent) should be true`);
assert(rootRef.isEqual(barQueryRef.parent.parent), `rootRef.isEqual(barQueryRef.parent.parent) should be true`);

assert(rootRef.isEqual(rootRef.ref), `rootRef.isEqual(rootRef.ref) should be true`);
assert(rootRef.isEqual(rootRef.ref.ref), `rootRef.isEqual(rootRef.ref.ref) should be true`);
assert(!barRef.isEqual(barQueryRef), `barRef.isEqual(barQueryRef) should be false`);
assert(barRef.isEqual(barQueryRef.ref), `barRef.isEqual(barQueryRef.ref) should be true`);
assert(!barQueryRef.isEqual(barQueryRef.ref), `barQueryRef.isEqual(barQueryRef.ref) should be false`);
assert(!barQueryRef.isEqual(barQueryRef.root), `barQueryRef.isEqual(barQueryRef.root) should be false`);

assert(rootRef.path === '/', `rootRef.path should be "/"`);
assert(barRef.path === '/foo/bar', `barRef.path should be "/foo/bar"`);
assert(barQueryRef.path === '/foo/bar', `barQueryRef.path should be "/foo/bar"`);


let accessToken;

const mockData = {
  one: 1,
  two: 'two',
  three: true,
  four: {
    five: 5,
    six: 6,
    seven: 7,
  },
};

return randomRef.set(mockData)
  .then(() => randomRef.get())
  .then((val) => {
    assert(_.isEqual(mockData, val), `Data fetched should equal data set`);
    return randomRef.childrenKeys();
  })
  .then((keys) => {
    assert(_.isEqual(keys.sort(), Object.keys(mockData).sort()), 'Children keys should return top-level keys');
    return randomRef.child('four').update({six: null, seven: false});
  })
  .then(() => randomRef.child('four').get())
  .then((val) => {
    assert(_.isEqual(val, {five: 5, seven: false}), `Data fetched should equal data updated`);
    return randomRef.remove();
  })
  .then(() => randomRef.get())
  .then((val) => {
    assert(val === null, `Deleted data fetched should be null`);

    console.log(`[INFO] All tests done running!`);
    process.exit(0);
  })
  .catch((error) => {
    console.log(`[ERROR] Tests failed:`, error);
    process.exit(1);
  });
