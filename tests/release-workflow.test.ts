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

  it('packages the existing PR Atlas logo as the desktop app icon', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { build?: { icon?: string } };

    expect(packageJson.build?.icon).toBe('public/favicon.png');
    expect(readFileSync(resolve(process.cwd(), 'public/favicon.png')).byteLength).toBeGreaterThan(0);
    expect(readFileSync(resolve(process.cwd(), 'public/pr-atlas-logo.png')).byteLength).toBeGreaterThan(0);
  });
});
