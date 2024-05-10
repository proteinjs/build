module.exports = {
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended', 'prettier'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'prettier'],
  root: true,
  ignorePatterns: ['**/dist/*', '**/node_modules/*', 'build-workspace.js'],

  rules: {
    'prettier/prettier': ['warn'],
    curly: ['warn'],
    'eol-last': ['warn', 'always'],
    'keyword-spacing': ['warn', { before: true }],
    'no-undef': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/prefer-as-const': 'off',
    '@typescript-eslint/ban-types': 'off',
  },
};
