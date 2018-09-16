const _ = require('lodash');
const assert = require('assert');

const admin = require('./loadFirebase');
const NodeFire = require('../nodefire.js');

console.log(`[INFO] Running tests...`)

const rootRef = new NodeFire(admin.database().ref(), {debugPermissionDeniedErrors: true});
const randomRef = rootRef.child('nodefire').push();
const randomQueryRef = randomRef.orderByChild('foo').limitToLast(10);

// return randomRef.transaction((current) => (current || 0) + 1)
//   .then(() => {
//     // assert(snap.val() === null, `Deleted data fetched should be null`);

//     console.log(`[INFO] All tests done running!`);
//     process.exit(0);
//   })
//   .catch((error) => {
//     console.log(`[ERROR] Tests failed:`, error);
//     process.exit(1);
//   });

return randomRef.update({foo: 1})
  .then(() => {
    // assert(snap.val() === null, `Deleted data fetched should be null`);

    console.log(`[INFO] All tests done running!`);
    process.exit(0);
  })
  .catch((error) => {
    console.log(`[ERROR] Tests failed:`, error);
    process.exit(1);
  });

// return randomRef.get()
//   .then(() => {
//     console.log(`[INFO] All tests done running!`);
//     process.exit(0);
//   })
//   .catch((error) => {
//     console.log(`[ERROR] Tests failed:`, error);
//     process.exit(1);
//   });

// return randomRef.on('value', () => {
//   console.log(`[INFO] All tests done running!`);
//   process.exit(0);
// }, (error) => {
//   console.log(`[ERROR] Tests failed:`, error);
//   process.exit(1);
// });
