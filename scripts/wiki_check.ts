/**
 * scripts/wiki_check.ts — lint the knowledge bundle; exit 1 on errors.
 *
 * WHY this file exists:
 *   The generic health gate for any OKF bundle the wiki tooling serves:
 *   conformance (frontmatter, `type`), link integrity, private-subtree
 *   closure, index coverage, orphans, staleness. Warnings inform; only
 *   errors fail — suitable for CI and pre-export hooks.
 *
 * RUN:  npm run wiki:check          (bundle at $WIKI_ROOT or <repo>/wiki)
 */

import { loadEnv } from '../lib/loadEnv.ts';
import { formatLintReport, lintVault } from '../lib/wiki/lint.ts';
import { loadVault, resolveWikiRoot } from '../lib/wiki/vault.ts';

loadEnv(import.meta.url);

const vault = loadVault(resolveWikiRoot());
const report = lintVault(vault);
console.log(formatLintReport(report));
process.exit(report.ok ? 0 : 1);
