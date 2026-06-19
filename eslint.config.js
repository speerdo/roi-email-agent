import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.vercel/',
      'dist/',
      'drizzle/',
      'node_modules/',
      'package-lock.json',
      'package.json',
      'vercel.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-throw-literal': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);