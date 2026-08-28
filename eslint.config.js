// @ts-check
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default tseslint.config(
    ...tseslint.configs.recommended,
    {
        ignores: ['dist/**', 'node_modules/**', '.cache/**', 'digests/**'],
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: rootDir,
            },
        },
        rules: {
            // TypeScript already enforces these; the lint pass focuses on hygiene.
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-unused-expressions': 'off',
        },
    },
    {
        // Tests live outside the build tsconfig (rootDir: src); tsconfig.test.json types them.
        files: ['test/**/*.ts', 'vitest.config.ts'],
        languageOptions: {
            parserOptions: {
                project: ['tsconfig.test.json'],
                tsconfigRootDir: rootDir,
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-unused-expressions': 'off',
        },
    },
);
