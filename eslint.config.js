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
        files: ['src/**/*.ts', 'test/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: {
                    // Test files live outside the build tsconfig (rootDir: src) but are
                    // still linted with the default project settings.
                    allowDefaultProject: ['test/*.ts'],
                },
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
);
