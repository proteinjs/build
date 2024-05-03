# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.3.0](https://github.com/proteinjs/build/compare/@proteinjs/build@1.2.2...@proteinjs/build@1.3.0) (2024-05-03)


### Features

* added `symlinkWorkspace` to symlink all local dependencies of all packages in the workspace ([da81067](https://github.com/proteinjs/build/commit/da810678641dee1360f1fb8d6dbed4f1e07d4ad0))





## [1.2.2](https://github.com/proteinjs/build/compare/@proteinjs/build@1.2.1...@proteinjs/build@1.2.2) (2024-05-02)


### Bug Fixes

* `workspacePackageCommand` needs to re-build packageMap after executing npm command ([2e39aba](https://github.com/proteinjs/build/commit/2e39ababfc9bda9db73acbb76c7d7aeeadf796b0))





## [1.2.1](https://github.com/proteinjs/build/compare/@proteinjs/build@1.2.0...@proteinjs/build@1.2.1) (2024-05-01)


### Bug Fixes

* `versionWorkspace` no longer attempt to color package names in commit messages ([d57728d](https://github.com/proteinjs/build/commit/d57728d87dfca79bafe8ff8fb231930787fe4731))





# [1.2.0](https://github.com/proteinjs/build/compare/@proteinjs/build@1.1.5...@proteinjs/build@1.2.0) (2024-04-30)


### Features

* `versionWorkspace` now supports fixed-version, private (non-published) workspaces ([3c63d72](https://github.com/proteinjs/build/commit/3c63d72bcc5f57300cc6fc0c76e0f568d2421eb1))





## [1.1.5](https://github.com/proteinjs/build/compare/@proteinjs/build@1.1.4...@proteinjs/build@1.1.5) (2024-04-27)


### Bug Fixes

* `versionWorkspace` pull meta repo before pushing to it ([08e7aaa](https://github.com/proteinjs/build/commit/08e7aaa82694e7893561add2d148b81fcd3488f1))





## [1.1.3](https://github.com/proteinjs/build/compare/@proteinjs/build@1.1.2...@proteinjs/build@1.1.3) (2024-04-24)


### Bug Fixes

* `versionWorksace` should fail fast if npm token is not available ([a079c77](https://github.com/proteinjs/build/commit/a079c77aaabb154f7760f9a3e08de73f67fe4279))





## [1.1.2](https://github.com/proteinjs/build/compare/@proteinjs/build@1.1.1...@proteinjs/build@1.1.2) (2024-04-24)


### Bug Fixes

* `versionWorkspace` erronously pushing meta repo after pulling workspace. not sure how that got there ([1d7571e](https://github.com/proteinjs/build/commit/1d7571e39086bf8ae049cbd46257bf98169b07b5))





## [1.1.1](https://github.com/proteinjs/build/compare/@proteinjs/build@1.1.0...@proteinjs/build@1.1.1) (2024-04-24)


### Bug Fixes

* `versionWorkspace` should re-symlink workspace dependencies after publishing packages so the workspace continues to function if not in ci ([98a2c39](https://github.com/proteinjs/build/commit/98a2c39494e38c60b910ca18fb7b806733cad123))





# [1.1.0](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.29...@proteinjs/build@1.1.0) (2024-04-24)


### Features

* added `workspace-package` to run commands from the workspace root in specific package directories. If a npm command is run, it re-symlinks the package dependencies ([a4da175](https://github.com/proteinjs/build/commit/a4da17549759ca4fd332c611c0e85a6f6e138f6d))





## [1.0.29](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.28...@proteinjs/build@1.0.29) (2024-04-24)


### Bug Fixes

* `versionWorkspace` back to cleaning before installing; fixed the @proteinjs/reflection-build-test-b build process ([c159916](https://github.com/proteinjs/build/commit/c159916ca86a7b1fb5cc43334c7ad58497f19432))





## [1.0.28](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.27...@proteinjs/build@1.0.28) (2024-04-24)


### Bug Fixes

* `versionWorkspace` should push meta repos recursively, deep to shallow ([9e062a3](https://github.com/proteinjs/build/commit/9e062a3e8b98c46b08d816b93b588aff6cf7f59e))





## [1.0.27](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.26...@proteinjs/build@1.0.27) (2024-04-23)


### Bug Fixes

* `versionWorkspace` should still push new versions of private packages (just not publish) ([1f5bfba](https://github.com/proteinjs/build/commit/1f5bfba974be44f68e2d971a24aa72e1c6854326))





## [1.0.25](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.24...@proteinjs/build@1.0.25) (2024-04-22)


### Bug Fixes

* `versionWorkspace` needs to pull the whole workspace before fetching `WorkspaceMetadata`; else we'll potentially have out-of-date package version info ([025f4fc](https://github.com/proteinjs/build/commit/025f4fc9786bfd53f3bec98221e627c55e2c256a))





## [1.0.24](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.23...@proteinjs/build@1.0.24) (2024-04-22)


### Bug Fixes

* `versionWorkspace` shoud pull before attempting to version a package ([ba5b683](https://github.com/proteinjs/build/commit/ba5b68357f0f1fae3c4494d931505b4088ccc8e2))





## [1.0.23](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.22...@proteinjs/build@1.0.23) (2024-04-22)


### Bug Fixes

* `versionWorkspace` shouldn't clean before installing (that can mess with more complicated build processes like @proteinjs/reflection-build-test-b). instead, just delete the package-lock pre-install ([8ceb1cd](https://github.com/proteinjs/build/commit/8ceb1cd6387a2bb91bbb0a381a73be70ed8f931c))





## [1.0.22](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.21...@proteinjs/build@1.0.22) (2024-04-22)


### Bug Fixes

* `versionWorkspace` should not attempt to bump versions of local path dependencies (ie: file:../b) ([58405d8](https://github.com/proteinjs/build/commit/58405d8bb11e563a9da6c5b5b9bdbdf3dd886448))





## [1.0.21](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.20...@proteinjs/build@1.0.21) (2024-04-22)


### Bug Fixes

* `versionWorkspace` was failing to get dependency versions from dev dependencies ([eb477a0](https://github.com/proteinjs/build/commit/eb477a044e2314a0fe5db296274c4d7f68f9b735))





## [1.0.20](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.19...@proteinjs/build@1.0.20) (2024-04-22)


### Bug Fixes

* `versionWorkspace` writing of package.json still needs to be formatted ([d25b00d](https://github.com/proteinjs/build/commit/d25b00daf6ebd63a3b6d4064346bfd0ae16eeeb6))





## [1.0.19](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.18...@proteinjs/build@1.0.19) (2024-04-22)


### Bug Fixes

* `versionWorkspace` needs to serialize package.jsons before writing them ([d31840c](https://github.com/proteinjs/build/commit/d31840c18b374746a9e80cce1d1a0e69e80834af))





## [1.0.18](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.17...@proteinjs/build@1.0.18) (2024-04-22)


### Bug Fixes

* `versionWorkspace` should still version (but not publish) private packages. ie. if we don't bump @proteinjs/reflection-build-test-a's depenency on @proteinjs/reflection when reflection changes, the test package's build will break ([c5fc5e5](https://github.com/proteinjs/build/commit/c5fc5e50fde9f138d4044f6ef3437ee7095b2672))





## [1.0.17](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.16...@proteinjs/build@1.0.17) (2024-04-22)

**Note:** Version bump only for package @proteinjs/build





## [1.0.16](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.15...@proteinjs/build@1.0.16) (2024-04-19)

**Note:** Version bump only for package @proteinjs/build





## [1.0.15](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.14...@proteinjs/build@1.0.15) (2024-04-19)


### Bug Fixes

* flags now work in `buildWorkspace` and `workspaceCommand` ([82e998c](https://github.com/proteinjs/build/commit/82e998c1cac50e42be34893d20b99369eef52a39))





## [1.0.14](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.13...@proteinjs/build@1.0.14) (2024-04-18)

**Note:** Version bump only for package @proteinjs/build





## [1.0.13](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.12...@proteinjs/build@1.0.13) (2024-04-18)

**Note:** Version bump only for package @proteinjs/build





## [1.0.12](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.11...@proteinjs/build@1.0.12) (2024-04-18)

**Note:** Version bump only for package @proteinjs/build





## [1.0.11](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.10...@proteinjs/build@1.0.11) (2024-04-18)

**Note:** Version bump only for package @proteinjs/build





## [1.0.10](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.9...@proteinjs/build@1.0.10) (2024-04-17)

**Note:** Version bump only for package @proteinjs/build





## [1.0.9](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.8...@proteinjs/build@1.0.9) (2024-04-17)

**Note:** Version bump only for package @proteinjs/build





## [1.0.8](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.7...@proteinjs/build@1.0.8) (2024-04-17)

**Note:** Version bump only for package @proteinjs/build





## [1.0.7](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.6...@proteinjs/build@1.0.7) (2024-04-16)

**Note:** Version bump only for package @proteinjs/build





## [1.0.6](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.5...@proteinjs/build@1.0.6) (2024-04-16)

**Note:** Version bump only for package @proteinjs/build





## [1.0.5](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.4...@proteinjs/build@1.0.5) (2024-04-16)

**Note:** Version bump only for package @proteinjs/build





## [1.0.4](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.3...@proteinjs/build@1.0.4) (2024-04-16)

**Note:** Version bump only for package @proteinjs/build





## [1.0.3](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.2...@proteinjs/build@1.0.3) (2024-04-16)

**Note:** Version bump only for package @proteinjs/build





## [1.0.2](https://github.com/proteinjs/build/compare/@proteinjs/build@1.0.1...@proteinjs/build@1.0.2) (2024-04-16)

**Note:** Version bump only for package @proteinjs/build





## 1.0.1 (2024-04-16)

**Note:** Version bump only for package @proteinjs/build
