import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('release workflow', () => {
  it('packages macOS on a currently supported Intel runner', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/release.yml'),
      'utf8',
    );

    expect(workflow).toContain('os: macos-15-intel');
    expect(workflow).not.toContain('os: macos-13');
  });
});
