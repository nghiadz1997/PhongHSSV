import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function runtimeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return runtimeFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('canonical dormitory runtime references', () => {
  it('contains no legacy collection, route, or identifier fallback', () => {
    const roots = [join(__dirname), join(__dirname, '..', '..', '..', 'frontend', 'src', 'api'), join(__dirname, '..', '..', '..', 'frontend', 'src', 'app', '(dashboard)', 'dormitory'), join(__dirname, '..', '..', '..', 'frontend', 'src', 'components', 'dormitory')];
    const forbidden = [`registration_${'id'}`, `public${'registrations'}`, `/dormitory/${'registrations'}`];
    const violations = roots.flatMap((root) => existsSync(root) && statSync(root).isDirectory() ? runtimeFiles(root) : []).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbidden.some((token) => source.includes(token)) ? [file] : [];
    });
    expect(violations).toEqual([]);
  });
});
