/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The prod-tag freeze for identity 8 (docs/runbooks/identity-v8-cutover.md) is a grep in three workflow files. A grep over a Terraform file
 * is only a guard while both sides keep their names, so this pins them: every workflow that can release a prod tag carries the step, it is
 * conditioned on a TAG, it names both flags, and the module still declares both variables and the live prod file still has them (set or
 * not): renaming a variable in one place would otherwise turn the guard into a check that can never pass or never fail.
 */
const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const FLAGS = ['better_auth_secret_set', 'edge_client_ip_secret_set'] as const;
const GUARDED = [
  '.github/workflows/backend-deploy.yml',
  '.github/workflows/web-deploy.yml',
  '.github/workflows/k8s-promote.yml',
];

describe('the identity 8 prod-tag guard', () => {
  it.each(GUARDED)('%s refuses a prod tag until both flags are true in infra/live/prod', (file) => {
    const text = read(file);
    const step = text.slice(text.indexOf('Refuse a prod tag until prod is ready for identity 8'));
    expect(step.length, `${file} has no guard step`).toBeGreaterThan(100);
    for (const flag of FLAGS) expect(step.slice(0, 900)).toContain(flag);
    expect(step.slice(0, 900)).toContain('infra/live/prod/main.tf');
    expect(step.slice(0, 1200)).toContain('exit 1');
    // tags only (k8s-promote's job already runs for a tag alone)
    if (!file.endsWith('k8s-promote.yml'))
      expect(text).toMatch(/Refuse a prod tag[^\n]*\n\s+if: github\.ref_type == 'tag'/);
  });

  it('the module declares both variables, and prod does not drop them from its vocabulary', () => {
    const variables = read('infra/modules/stack/variables.tf');
    for (const flag of FLAGS) expect(variables).toContain(`variable "${flag}"`);
    expect(variables).toContain('variable "identity_v8_backfill_on_deploy"');
  });

  it('develop has both flags true (so the guard has something to pass against), and the backfill-on-deploy flag is not set anywhere live', () => {
    const develop = read('infra/live/develop/main.tf');
    for (const flag of FLAGS) expect(develop).toMatch(new RegExp(`^\\s*${flag}\\s*=\\s*true`, 'm'));
    for (const env of ['develop', 'prod']) {
      expect(read(`infra/live/${env}/main.tf`)).not.toContain('identity_v8_backfill_on_deploy');
    }
  });

  it("the web deploy of a tag waits for that tag's backend deploy, for longer than the infra gate", () => {
    const text = read('.github/workflows/web-deploy.yml');
    expect(text).toContain('wait-for-backend');
    expect(text).toMatch(/branch: \$\{\{ github\.ref_name \}\}/);
    expect(text).toMatch(/timeout-minutes: 360/);
  });
});
