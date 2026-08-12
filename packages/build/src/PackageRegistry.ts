import * as path from 'path';
import { LocalPackage, cmd, Fs, LogColorWrapper } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import semver from 'semver';
import { primaryLogColor, secondaryLogColor } from './logColors';

const cw = new LogColorWrapper();
const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('registry', secondaryLogColor) });

/**
 * Seam between the versioning flow and the package registry. The release baseline for every
 * package comes from the registry at run time (`getPublishedVersions`), and a version only
 * becomes durable once the registry has accepted it (`publish`) — so this interface is the
 * single authority the flow consults for "what is actually released". Tests substitute an
 * in-memory implementation to stage registry states (desyncs, lineage collisions, flaky
 * publishes) hermetically.
 */
export interface PackageRegistry {
  /**
   * The full published version list for the package on ITS OWN registry (per-package
   * publishConfig/.npmrc — e.g. @n3xah on npm.pkg.github.com, @proteinjs on npmjs).
   * Returns `[]` for a package that has never been published. Not cached here — the
   * resume/acceptance checks re-query and need registry truth, not a snapshot; callers
   * that can tolerate a run-scoped snapshot (the prior-run rewrite reads) cache on their
   * own side.
   */
  getPublishedVersions(localPackage: LocalPackage): Promise<string[]>;
  /**
   * Publish the package directory contents as `packageJson.version`. Resolves only on
   * registry acceptance; rejects otherwise (including "version already exists").
   */
  publish(localPackage: LocalPackage): Promise<void>;
}

/**
 * Production `PackageRegistry` backed by the npm CLI. Every command runs with the package's
 * own `.npmrc` as `--userconfig` (auth for private registries) and the registry from its
 * `publishConfig` — a bare `npm view` against npm.pkg.github.com 404s without auth and
 * silently lies about published state.
 */
export class NpmPackageRegistry implements PackageRegistry {
  private authCheckedRegistries: { [registry: string]: boolean } = {};

  async getPublishedVersions(localPackage: LocalPackage): Promise<string[]> {
    const registry = this.publishRegistry(localPackage);
    const packageDir = path.dirname(localPackage.filePath);
    // GitHub Packages (and private registries generally) answer unauthenticated reads with
    // 404 — indistinguishable from "never published". Prove auth first so a 404 below is
    // a true "no versions", not a lie. Public npmjs reads need no auth.
    if (!this.isNpmjs(registry)) {
      await this.assertAuth(registry, localPackage);
    }
    const userconfigArgs = await this.userconfigArgs(packageDir);

    let stdout: string;
    try {
      // Retried on transients: a rate-limit 403 flap on this exact metadata GET killed train
      // attempt 12 (2026-08-12) — the read succeeded seconds later. Non-transient errors (the
      // authenticated 404 below) rethrow on the first attempt.
      const result = await retryOnNetworkError(
        () =>
          cmd(
            'npm',
            ['view', localPackage.name, 'versions', '--json', '--registry', registry, ...userconfigArgs],
            { cwd: packageDir, env: { ...process.env } },
            { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
          ),
        localPackage.name
      );
      stdout = result.stdout;
    } catch (error: any) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      if (/E404/i.test(output) || /404 Not Found/i.test(output)) {
        return []; // authenticated 404: the package has never been published to its registry
      }
      throw error;
    }

    if (!stdout.trim()) {
      return [];
    }
    const parsed = JSON.parse(stdout);
    // npm prints a bare string when exactly one version exists, an array otherwise.
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async publish(localPackage: LocalPackage): Promise<void> {
    const publishConfig = localPackage.packageJson.publishConfig ?? {};
    const registry = this.publishRegistry(localPackage);
    const tag = publishConfig.tag ?? 'latest';
    const access = publishConfig.access;
    const packageDir = path.dirname(localPackage.filePath);

    await this.assertAuth(registry, localPackage);

    logger.info({
      message: `(${cw.color(localPackage.name)}) publishing latest version (${localPackage.packageJson.version}) [registry=${registry}]`,
    });

    // Use publishConfig as the source of truth
    const args = ['publish', '--tag', tag, ...(await this.userconfigArgs(packageDir))];
    // Only include --access when publishing to the public npm registry
    if (this.isNpmjs(registry) && access) {
      args.push('--access', access);
    }

    await retryOnNetworkError(
      () =>
        cmd(
          'npm',
          args,
          { cwd: packageDir, env: { ...process.env } },
          { logPrefix: `[${cw.color(localPackage.name)}] ` }
        ),
      localPackage.name,
      3,
      15_000
    );

    logger.info({ message: `(${cw.color(localPackage.name)}) published ${localPackage.packageJson.version}` });
  }

  private publishRegistry(localPackage: LocalPackage): string {
    const publishConfig = localPackage.packageJson.publishConfig ?? {};
    if (publishConfig.registry) {
      return publishConfig.registry;
    }

    return 'https://registry.npmjs.org/';
  }

  private isNpmjs(registry: string): boolean {
    try {
      return new URL(registry).hostname.endsWith('npmjs.org');
    } catch {
      return false; // malformed URL: treat as non-public so reads still prove auth
    }
  }

  private async assertAuth(registry: string, localPackage: LocalPackage) {
    if (!registry || this.authCheckedRegistries[registry]) {
      return;
    }
    const packageDir = path.dirname(localPackage.filePath);
    const userconfigArgs = await this.userconfigArgs(packageDir);
    // Same transient class as the metadata GET: an auth probe that flaps 403 must not kill a
    // train; a real credential problem still exhausts the retries and surfaces.
    await retryOnNetworkError(
      () =>
        cmd(
          'npm',
          ['whoami', '--registry', registry, ...userconfigArgs],
          { cwd: packageDir, env: { ...process.env } },
          { logPrefix: `[${cw.color(localPackage.name)}] ` }
        ),
      localPackage.name
    );
    this.authCheckedRegistries[registry] = true;
  }

  private async userconfigArgs(packageDir: string): Promise<string[]> {
    const rc = path.join(packageDir, '.npmrc');
    return (await Fs.exists(rc)) ? ['--userconfig', rc] : [];
  }
}

/**
 * Max published version across the FULL version list — never the `latest` dist-tag, which can
 * diverge from version order (2026-08-12 train: sibling workspaces' releases left `latest`
 * pointing below the numeric max on several @n3xah packages).
 */
export function maxPublishedVersion(versions: string[]): string | undefined {
  const valid = versions.filter((v) => semver.valid(v));
  if (valid.length === 0) {
    return undefined;
  }
  return valid.sort(semver.compare)[valid.length - 1];
}

export function isNetworkError(error: any): boolean {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  return (
    /ECONNRESET/i.test(output) ||
    /ETIMEDOUT/i.test(output) ||
    /ENOTFOUND/i.test(output) ||
    /EAI_AGAIN/i.test(output) ||
    /ECONNREFUSED/i.test(output) ||
    /socket hang up/i.test(output) ||
    /network/i.test(output) ||
    // GitHub Packages surfaces rate limiting and transient auth-path flaps as 403 with a generic
    // "forbidden by your security policy" body (observed killing train attempt 12 on a plain
    // metadata GET that succeeded seconds later) — a REAL permission problem still exhausts the
    // retry budget and surfaces, so retrying 403s trades ~45s for surviving the flap.
    /npm error 403/i.test(output) ||
    /E403/i.test(output)
  );
}

export async function retryOnNetworkError<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
  retryDelayMs = 15_000
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (!isNetworkError(error) || attempt === maxRetries) {
        throw error;
      }
      logger.info({
        message: `(${cw.color(label)}) network error, retrying (attempt ${attempt}/${maxRetries}, next retry in ${retryDelayMs / 1000}s)`,
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
