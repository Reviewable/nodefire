const fs = require('fs');
const path = require('path');
const {google} = require('googleapis');

const pathToServiceAccount = path.resolve(__dirname, '../resources/serviceAccount.json');
if (!fs.existsSync(pathToServiceAccount)) {
  console.log(
    `[ERROR] Firebase service account not found. Please place it in ${pathToServiceAccount}.`
  );
  process.exit(1);
}

const serviceAccount = require(pathToServiceAccount);

/**
 * Generates a Google OAuth2 access token for use authenticating to Firebase services, such as the
 * Firebase Realtime Database REST API.
 * 
 * See https://firebase.google.com/docs/database/rest/auth#google_oauth2_access_tokens.
 */
module.exports.fetchAccessToken = () => {
  // Define the required scopes.
  const scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/firebase.database"
  ];

  // Authenticate a JWT client with the service account.
  const jwtClient = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    scopes
  );

  // Fetch the Google OAuth2 access token.
  return new Promise((resolve, reject) => {
    jwtClient.authorize((error, tokens) => {
      if (error) {
        reject(new Error(`Error making request to generate access token: ${error.toString()}`));
      } else if (tokens.access_token === null) {
        reject(new Error(`Provided service account does not have permission to generate access tokens`));
      } else {
        resolve(tokens.access_token);
      }
    });
  });
}
