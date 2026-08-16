import * as path from 'path';
import * as fs from 'fs/promises';
import semver from 'semver';
import { LocalPackage } from '@proteinjs/util-node';
import { PackageRegistry } from '../src/PackageRegistry';

/**
 * Shared harness for the registry-reconciled versioning suites (local-train reconciliation and
 * the CI publish mode). One fake registry + one install model — the two suites must exercise
 * the SAME registry semantics, so the modeling lives here, not per-file.
 */

export type PublishEvent = { name: string; version: string };

export class FakeRegistry implements PackageRegistry {
  publishEvents: PublishEvent[] = [];
  /** Override what `getPublishedVersions` reports, by package and 1-indexed call number. */
  versionsBehavior = new Map<string, (call: number, current: string[]) => string[]>();
  /** Override publish handling per package (e.g. accept-then-throw, reject outright). */
  publishBehavior = new Map<string, (localPackage: LocalPackage) => Promise<void> | void>();
  private versions = new Map<string, string[]>();
  private versionsCallCounts = new Map<string, number>();

  seed(name: string, versions: string[]) {
    this.versions.set(name, [...versions]);
  }

  published(name: string): string[] {
    return [...(this.versions.get(name) ?? [])];
  }

  accept(name: string, version: string) {
    const list = this.versions.get(name) ?? [];
    list.push(version);
    this.versions.set(name, list);
  }

  async getPublishedVersions(localPackage: LocalPackage): Promise<string[]> {
    const call = (this.versionsCallCounts.get(localPackage.name) ?? 0) + 1;
    this.versionsCallCounts.set(localPackage.name, call);
    const current = this.published(localPackage.name);
    const behavior = this.versionsBehavior.get(localPackage.name);
    return behavior ? behavior(call, current) : current;
  }

  async publish(localPackage: LocalPackage): Promise<void> {
    const version = localPackage.packageJson.version;
    if (this.published(localPackage.name).includes(version)) {
      throw Object.assign(new Error(`cannot publish over previously published version ${version}`), {
        stderr: 'npm ERR! code EPUBLISHCONFLICT',
      });
    }
    const behavior = this.publishBehavior.get(localPackage.name);
    if (behavior) {
      await behavior(localPackage);
      return;
    }
    this.accept(localPackage.name, version);
    this.publishEvents.push({ name: localPackage.name, version });
  }
}

/**
 * Stand-in for clean/install/build/test that models the part of `npm install` the versioning
 * flow's correctness depends on: DEPENDENCY RESOLUTION.
 *
 *   - Ranges are read from the package.json ON DISK at install time — what npm reads. The
 *     rewrite must land on disk before the install for this to see it; a pipeline that
 *     installs against pre-rewrite ranges goes red in every fixture with dependencies.
 *   - An existing lockfile pin is honored while it still SATISFIES its range (npm's actual
 *     behavior — the attempt-13 mechanism: a stale-but-satisfying pin binds the install to
 *     pre-release content). Otherwise resolution is semver.maxSatisfying over the registry's
 *     published list, and an unsatisfiable range on a known package throws (ETARGET class —
 *     what a rewrite to a never-published version dies on in production).
 *   - Resolutions are written back as the regenerated lockfile's `packages` entries, exactly
 *     where the real train records them — fixtures assert the resolved versions there.
 */
export const makeFakeBuildAndTest = (registry: FakeRegistry) => async (localPackage: LocalPackage) => {
  const packageDir = path.dirname(localPackage.filePath);
  const diskJson = JSON.parse(await fs.readFile(localPackage.filePath, 'utf-8'));
  const lockPath = path.join(packageDir, 'package-lock.json');
  let previousLock: any = {};
  try {
    previousLock = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
  } catch {
    // no lockfile yet — fresh resolution for everything
  }
  const resolvedPackages: Record<string, { version: string }> = {};
  const ranges: Record<string, unknown> = { ...(diskJson.dependencies ?? {}), ...(diskJson.devDependencies ?? {}) };
  for (const [depName, range] of Object.entries(ranges)) {
    if (typeof range !== 'string' || !semver.validRange(range)) {
      continue; // file:/path deps and other non-registry references
    }
    const published = registry.published(depName);
    if (published.length === 0) {
      continue; // not a package the fake registry models
    }
    const pin = previousLock.packages?.[`node_modules/${depName}`]?.version;
    const resolved = pin && semver.satisfies(pin, range) ? pin : semver.maxSatisfying(published, range);
    if (!resolved) {
      throw Object.assign(new Error(`No matching version found for ${depName}@${range}`), {
        stderr: 'npm ERR! code ETARGET',
      });
    }
    resolvedPackages[`node_modules/${depName}`] = { version: resolved };
  }
  await fs.writeFile(
    lockPath,
    JSON.stringify(
      { name: diskJson.name, version: diskJson.version, lockfileVersion: 3, packages: resolvedPackages },
      null,
      2
    ) + '\n'
  );
};

export const packageJsonFor = (name: string, version: string, dependencies?: Record<string, string>) => ({
  name,
  version,
  scripts: { clean: 'true', build: 'true' },
  publishConfig: { registry: 'http://fake-registry.invalid/' },
  ...(dependencies ? { dependencies } : {}),
});
