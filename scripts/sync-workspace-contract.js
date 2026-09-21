#!/usr/bin/env node
// sync-workspace-contract — keep the workspace's copy of the contract identical
// to the canonical one in this repo.
//
//   node scripts/sync-workspace-contract.js            write the copy
//   node scripts/sync-workspace-contract.js --check     fail if it has drifted
//
// ── WHY A COPY AT ALL ───────────────────────────────────────────────────────
//
// The canonical contract is yarms-core/WORKSPACE.md, beside ARCHITECTURE.md, the
// machine half that enforces it. But Claude Code loads its standards from
// CLAUDE.md files at and above the working directory, so a session opened in
// yarms_agents or yarms_co_portal never reads this repo.
//
// The obvious fix — a one-line `@yarms-core/WORKSPACE.md` import in the root
// CLAUDE.md — was tried on 2026-09-21 and SILENTLY DOES NOT WORK from a
// subproject: an import that resolves outside the working directory is gated
// behind an approval dialog, so the pointer loads and its contents do not. No
// error, no warning; the standards were simply absent in every session started
// anywhere but the workspace root.
//
// So the root file carries the full text, and this script is what keeps the two
// honest. A copy nobody checks is how the drift starts; a copy that fails a
// commit is a copy that stays right.

const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const BANNER_END = '<!-- end generated banner -->';

// yarms-core sits inside the workspace it describes. When this package is
// installed as a dependency it does not, and then there is no root copy to write
// — refuse rather than scribble into somebody's node_modules.
function workspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  if (__dirname.includes('node_modules')) {
    throw new Error('running from node_modules — this script only makes sense in a yarms-core checkout inside the workspace');
  }
  return path.resolve(__dirname, '..', '..');
}

const banner = (canonicalPath) => [
  '<!--',
  '  GENERATED FILE — do not edit.',
  '',
  `  The contract lives in ${canonicalPath}, beside ARCHITECTURE.md, the machine`,
  '  half that enforces it. This copy exists only because Claude Code reads its',
  '  standards from CLAUDE.md at and above the working directory, and an @import',
  '  that points outside the working directory is gated — so a session opened in a',
  '  subproject would load a pointer and none of its contents.',
  '',
  '  To change the standards:  edit yarms-core/WORKSPACE.md',
  '                            npm --prefix yarms-core run sync:workspace',
  '',
  '  yarms-core refuses to commit a change to WORKSPACE.md while this copy differs.',
  '-->',
  BANNER_END,
  '',
].join('\n');

// A shared skill has the same problem as the contract and the same answer: the
// runbook stays canonical here, and a pointer under .claude/skills keeps it
// discoverable from anywhere in the workspace. The pointer carries the canonical
// file's OWN frontmatter, so a change to the description reaches it on the next
// sync instead of quietly disagreeing.
function skillPointer(canonicalSkill, repoRelative) {
  const text = fs.readFileSync(canonicalSkill, 'utf8');
  const m = /^---\r?\n([\s\S]*?\r?\n)---/.exec(text);
  if (!m) throw new Error(`${canonicalSkill} has no frontmatter to carry into the pointer`);
  return [
    '---',
    m[1].replace(/\s+$/, ''),
    '---',
    '',
    `# ${(/^name:\s*(.+)$/m.exec(m[1]) || [, 'skill'])[1].trim()}`,
    '',
    `**Read \`${repoRelative}\`** — that is the skill, and it is the versioned copy.`,
    '',
    'This pointer exists so the skill is discoverable from anywhere in the workspace while',
    'its text lives in the repo that carries the standards. A runbook copied into two files',
    'is a runbook that is wrong in one of them.',
    '',
  ].join('\n');
}

// Everything this script keeps in step: [canonical, where the copy goes, how to build it].
function targets(root) {
  const out = [{
    what: 'the contract',
    canonical: path.join(__dirname, '..', 'WORKSPACE.md'),
    copy: path.join(root, 'CLAUDE.md'),
    build: (canonical) => banner('yarms-core/WORKSPACE.md') + fs.readFileSync(canonical, 'utf8').replace(/\s+$/, '') + '\n',
  }];
  const skillsDir = path.join(__dirname, '..', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      const canonical = path.join(skillsDir, name, 'SKILL.md');
      if (!fs.existsSync(canonical)) continue;
      out.push({
        what: `the ${name} skill pointer`,
        canonical,
        copy: path.join(root, '.claude', 'skills', name, 'SKILL.md'),
        build: (c) => skillPointer(c, `yarms-core/skills/${name}/SKILL.md`),
      });
    }
  }
  return out;
}

function main() {
  const root = workspaceRoot();
  let drifted = 0;

  for (const target of targets(root)) {
    if (!fs.existsSync(target.canonical)) {
      console.error(`missing canonical file: ${target.canonical}`);
      process.exit(1);
    }
    const expected = target.build(target.canonical);

    if (!CHECK) {
      fs.mkdirSync(path.dirname(target.copy), { recursive: true });
      fs.writeFileSync(target.copy, expected);
      console.log(`wrote ${target.copy} (${target.what}, ${expected.length} chars)`);
      continue;
    }
    if (!fs.existsSync(target.copy)) {
      console.error(`the workspace has no copy of ${target.what} at ${target.copy}`);
      drifted++;
      continue;
    }
    if (fs.readFileSync(target.copy, 'utf8') !== expected) {
      console.error(`${target.what}: ${target.copy} does not match ${path.basename(target.canonical)}`);
      drifted++;
    }
  }

  if (!CHECK) return;
  if (!drifted) {
    console.log('the workspace copies are in step with yarms-core');
    return;
  }
  reportDrift(root);
}

function reportDrift(root) {
  const canonical = path.join(__dirname, '..', 'WORKSPACE.md');
  const copy = path.join(root, 'CLAUDE.md');
  const expected = banner('yarms-core/WORKSPACE.md') + fs.readFileSync(canonical, 'utf8').replace(/\s+$/, '') + '\n';
  const actual = fs.existsSync(copy) ? fs.readFileSync(copy, 'utf8') : '';

  // Say WHICH way it drifted — the fix differs. A copy that is merely stale is
  // regenerated and nothing is lost; a copy somebody edited by hand holds changes
  // that the next sync would silently overwrite, and those have to move first.
  if (actual) {
    const canonicalBody = expected.slice(expected.indexOf(BANNER_END));
    const copyBody = actual.slice(actual.indexOf(BANNER_END));
    console.error(copyBody === canonicalBody
      ? '  only the generated banner differs — regenerating is safe'
      : '  their CONTENTS differ. If the edit was made in the copy, move it into '
        + 'yarms-core/WORKSPACE.md FIRST: the next sync overwrites the copy.');
  }
  console.error('  then: npm --prefix yarms-core run sync:workspace');
  process.exit(1);
}

main();
