import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_WORKSPACES = [
  'apps/hosted-agent',
  'apps/local-server',
  'apps/mcp',
  'apps/starter',
  'apps/web',
  'packages/shared',
  'packages/upstash-client',
];

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function expandWorkspace(root, pattern) {
  if (!pattern.endsWith('/*')) {
    return [pattern];
  }
  const parent = pattern.slice(0, -2);
  const entries = await readdir(path.join(root, parent), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

export async function checkTestWorkspaceRoster(root) {
  const rootManifest = await readJson(path.join(root, 'package.json'));
  const patterns = rootManifest.workspaces;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('root package.json must declare a nonempty workspace list');
  }

  const discovered = (
    await Promise.all(patterns.map((pattern) => expandWorkspace(root, pattern)))
  ).flat().sort();
  const expected = [...EXPECTED_WORKSPACES].sort();
  if (JSON.stringify(discovered) !== JSON.stringify(expected)) {
    throw new Error(
      `workspace roster mismatch: expected ${expected.join(', ')}; discovered ${discovered.join(', ')}`,
    );
  }

  const missing = [];
  for (const workspace of discovered) {
    const manifest = await readJson(path.join(root, workspace, 'package.json'));
    if (typeof manifest.scripts?.test !== 'string' || manifest.scripts.test.trim() === '') {
      missing.push(workspace);
    }
  }
  if (missing.length > 0) {
    throw new Error(`workspace test script missing: ${missing.join(', ')}`);
  }

  return discovered;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  try {
    const workspaces = await checkTestWorkspaceRoster(root);
    console.log(`workspace test roster verified: ${workspaces.length}/${EXPECTED_WORKSPACES.length}`);
  } catch (error) {
    console.error(`workspace test roster check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
