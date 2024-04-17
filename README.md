# Overview

A set of tools for managing workspace build operations, working directly on top of npm. No config required to use.

## How to use

1. Install as a dev dependency of your workspace root package `npm i --save-dev @proteinjs/build`
2. The following commands are now available
    - `npx build-workspace` runs `npm install` and `npm run build` for each package, in dependency order, until the workspace is built
    - `npx test-workspace` runs `npm run test` for each package
    - `npx watch-workspace` runs `npm run watch` for each package

**Note:** if a script is not defined for a package (ie. `build`|`test`|`watch`), the package will be skipped when running the workspace command instead of failing.

## How it works

- Each script searches recursively for local packages, starting in the directory you executed the command in, and builds a dependency graph used for command sequencing.
- During the install phase, it creates symlinks to local dependencies.
    - Local dependencies are determined by the filesystem search, not by the dependency version specified in the package.json.
    - This is useful for being able to specify explicit dependency versions for publishing, while also being able to build from local source during development. It all just works.
    - Note: if publishing packages, keep in mind that the package must be published first before any package can depend on the explicit version and leverage the symlinking of this library. This is because `npm i` is first executed, and then symlinks are created afterwards, blowing away the version installed from the registry. The `npm i` command will fail (per usual) if your package depends on an explicit version of a package that doesn't exist in the registry.