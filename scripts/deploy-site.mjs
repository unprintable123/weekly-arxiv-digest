/**
 * Publish dist/site to the `gh-pages` branch using a temporary git worktree:
 * dist/site content becomes the branch root, committed and pushed. No extra
 * dependencies — plain git + node:fs. Safe to re-run: the branch is updated
 * from the local tree each time.
 *
 * Env: GH_PAGES_REMOTE (default "origin"), GH_PAGES_BRANCH (default "gh-pages").
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'dist', 'site');
const worktreeDir = join(root, 'dist', 'gh-pages-worktree');
const remote = process.env.GH_PAGES_REMOTE || 'origin';
const branch = process.env.GH_PAGES_BRANCH || 'gh-pages';

if (!existsSync(join(siteDir, 'index.html'))) {
    console.error('error: dist/site/index.html missing; run `pnpm site:build` first');
    process.exit(1);
}

/** @param {string[]} args @param {string} [cwd] @param {string} [label] */
function git(args, cwd = root, label) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
        console.error(`error: git ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
        process.exit(1);
    }
    if (label) console.log(label);
}

const branchExists =
    spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: root,
        encoding: 'utf8',
    }).status === 0;

rmSync(worktreeDir, { recursive: true, force: true });
git(['worktree', 'prune']);

if (branchExists) {
    git(['worktree', 'add', '--force', worktreeDir, branch], root, `checked out ${branch}`);
} else {
    // First publish: a detached worktree plus an orphan checkout gives the
    // site branch a clean root with no unrelated source history.
    git(['worktree', 'add', '--detach', worktreeDir]);
    git(['-C', worktreeDir, 'checkout', '--orphan', branch], root, `created orphan ${branch}`);
    git(['-C', worktreeDir, 'rm', '-rf', '--quiet', '.'], worktreeDir);
}

// Mirror dist/site into the worktree root, keeping only the .git pointer.
for (const entry of readdirSync(worktreeDir)) {
    if (entry === '.git') continue;
    rmSync(join(worktreeDir, entry), { recursive: true, force: true });
}
cpSync(siteDir, worktreeDir, { recursive: true });

git(['-C', worktreeDir, 'add', '-A']);
const nothingStaged =
    spawnSync('git', ['-C', worktreeDir, 'diff', '--cached', '--quiet'], { encoding: 'utf8' }).status === 0;

if (nothingStaged) {
    console.log(JSON.stringify({ pushed: false, reason: 'no changes', branch }));
} else {
    git([
        '-C',
        worktreeDir,
        '-c',
        'user.name=weekly-digest-site',
        '-c',
        'user.email=site@weekly-digest.local',
        'commit',
        '-m',
        `site: publish ${new Date().toISOString()}`,
    ]);
    git(['push', remote, branch], root);
    console.log(JSON.stringify({ pushed: true, branch, remote }));
}

git(['worktree', 'remove', '--force', worktreeDir]);
git(['worktree', 'prune']);
