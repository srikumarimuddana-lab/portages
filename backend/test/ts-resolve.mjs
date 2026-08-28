// Test-only ESM resolve hook.
// Production code imports with ".js" specifiers (required for compiled ESM
// output). When running tests directly from TypeScript sources, map those to
// the ".ts" file on disk. Nothing here affects the built artifact.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return next(candidate.href, context);
    }
  }
  return next(specifier, context);
}
