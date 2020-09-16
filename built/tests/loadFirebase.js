var fs = require('fs');
var path = require('path');
var admin = require('firebase-admin');
var pathToServiceAccount = path.resolve(__dirname, '../resources/serviceAccount.json');
if (!fs.existsSync(pathToServiceAccount)) {
    console.log("[ERROR] Firebase service account not found. Please place it in " + pathToServiceAccount + ".");
    process.exit(1);
}
var serviceAccount = require(pathToServiceAccount);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://" + serviceAccount.project_id + ".firebaseio.com",
});
module.exports = admin;
