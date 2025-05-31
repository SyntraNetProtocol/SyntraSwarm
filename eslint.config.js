// eslint.config.js
import globals from 'globals';
import pluginJs from '@eslint/js';
import pluginHtml from 'eslint-plugin-html';
// Prettier integration - using eslint-config-prettier directly is common
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  // 1. Global ignores (replaces .eslintignore)
  {
    ignores: [
      'node_modules/',
      'dist/',
      'build/',
      'SyntraCloud/', // Example: Ignore backend
      // Add other patterns as needed
    ],
  },

  // 2. ESLint Recommended Rules (Core JS linting)
  pluginJs.configs.recommended,

  // 3. Configuration for JS files specifically
  {
    files: ['**/*.js'], // Apply only to .js files
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module', // Use 'commonjs' if you use require/module.exports primarily
      globals: {
        ...globals.browser, // Browser environment globals (window, document, etc.)
        ...globals.node,    // Node.js environment globals (process, require, etc.)
        // Custom global variables used across the frontend
        axios: 'readonly',
        logMsg: 'readonly',
        showErr: 'readonly',
        BASE_URL: 'readonly',
        Terminal: 'readonly',
        FitAddon: 'readonly',
        WebLinksAddon: 'readonly',
        logDashboardMsg: 'readonly',
      },
    },
    rules: {
      // Ignore unused vars/args/catch parameters prefixed with underscore
      'no-unused-vars': ['error', {
        'varsIgnorePattern': '^_',
        'argsIgnorePattern': '^_',
        'caughtErrorsIgnorePattern': '^_'
      }],
    },
  },

  // 4. Configuration for HTML files (linting script tags)
  {
    files: ['**/*.html'], // Apply only to .html files
    plugins: {
      html: pluginHtml, // Assign the HTML plugin
    },
    // Disable undefined and unused var checks in HTML script blocks
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },

  // 5. Prettier Compatibility (MUST BE LAST)
  // This effectively disables ESLint rules that conflict with Prettier
  eslintConfigPrettier,

  // --- Optional: Add eslint-plugin-prettier for reporting ---
  // If you want Prettier issues reported as ESLint issues (often preferred):
  // {
  //   plugins: {
  //     prettier: pluginPrettier
  //   },
  //   rules: {
  //     "prettier/prettier": "warn" // Or "error"
  //   }
  // },
  // Note: You might need to install `eslint-plugin-prettier` if doing this,
  // and import it: `import pluginPrettier from 'eslint-plugin-prettier';`
  // However, many find just using `eslint-config-prettier` and running `prettier --check`
  // or relying on editor integration sufficient. Let's keep it simpler for now.
];