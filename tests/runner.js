const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const assert = require('assert');
const admin = require('firebase-admin');

const utils = require('./utils.js');
const NodeFire = require('../nodefire.js');

const pathToServiceAccount = path.resolve(__dirname, '../resources/serviceAccount.json');
if (!fs.existsSync(pathToServiceAccount)) {
  console.log(
    `[ERROR] Firebase service account not found. Please place it in ${pathToServiceAccount}.`
  );
  process.exit(1);
}

const serviceAccount = require(pathToServiceAccount);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
});

console.log(`[INFO] Running tests...`)

const rootRef = new NodeFire(admin.database().ref());
const randomRef = rootRef.push();

const mockData = {
  one: 1,
  two: false,
  three: 'three',
};

return randomRef.set(mockData)
  .then(() => utils.fetchAccessToken(serviceAccount))
  .then((accessToken) => randomRef.childrenKeys({accessToken}))
  .then((keys) => {
    assert(_.isEqual(keys.sort(), Object.keys(mockData).sort()), 'Children keys should return top-level keys');
    console.log(`[INFO] All tests done running!`);
    process.exit(0);
  })
  .catch((error) => {
    console.log(`[ERROR] Tests failed:`, error);
    process.exit(1);
  });
