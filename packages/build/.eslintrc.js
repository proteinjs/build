module.exports = {
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'prettier'],
  root: true,
  ignorePatterns: ['**/dist/*', '**/node_modules/*', 'build-workspace.js'],
  rules: {
    'prettier/prettier': ['error'],
    curly: ['error', 'multi-or-nest'],
    'eol-last': ['error', 'always'],
    'keyword-spacing': ['error', { before: true }],
    'no-undef': 'off',
    'no-constant-condition': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
