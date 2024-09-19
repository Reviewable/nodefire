import globals from 'globals';
import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';
import reviewableConfigLodash from 'reviewable-configs/eslint-config/lodash.js';
import reviewableConfigTypescript from 'reviewable-configs/eslint-config/typescript.js';

export default [
  ...reviewableConfigBaseline,
  ...reviewableConfigLodash,
  ...reviewableConfigTypescript,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2015
      },
      ecmaVersion: 2018
    }
  }
];
