import { classifyCommitMessage } from '../src/versionWorkspace';

describe('classifyCommitMessage', () => {
  describe('major (breaking-change)', () => {
    it('classifies `feat!:` as major', () => {
      expect(classifyCommitMessage('feat!: remove deprecated api')).toBe('major');
    });

    it('classifies `fix!:` as major', () => {
      expect(classifyCommitMessage('fix!: change default behavior')).toBe('major');
    });

    it('classifies scoped `feat(scope)!:` as major', () => {
      expect(classifyCommitMessage('feat(auth)!: replace cookie format')).toBe('major');
    });

    it('classifies `BREAKING CHANGE:` footer as major', () => {
      expect(
        classifyCommitMessage(
          'feat: reorganize tool outputs\n\nDetails here.\n\nBREAKING CHANGE: tool result shape changed'
        )
      ).toBe('major');
    });

    it('classifies `BREAKING-CHANGE:` (hyphenated) as major', () => {
      expect(classifyCommitMessage('refactor: blah\n\nBREAKING-CHANGE: something')).toBe('major');
    });

    it('classifies a `BREAKING CHANGE:` footer that directly follows a body line as major', () => {
      // Not every author leaves a blank line before the footer; a line that
      // *starts* with the token is a declaration in any reading.
      expect(classifyCommitMessage('feat: x\n\nSome body.\nBREAKING CHANGE: y')).toBe('major');
    });

    it('classifies a subject that is itself the footer token as major', () => {
      expect(classifyCommitMessage('BREAKING CHANGE: removed old flow')).toBe('major');
    });
  });

  describe('minor (feat)', () => {
    it('classifies `feat:` as minor', () => {
      expect(classifyCommitMessage('feat: add streaming support')).toBe('minor');
    });

    it('classifies scoped `feat(scope):` as minor', () => {
      expect(classifyCommitMessage('feat(ui): new button')).toBe('minor');
    });

    it('is case-insensitive for type', () => {
      expect(classifyCommitMessage('FEAT: uppercase type')).toBe('minor');
    });
  });

  describe('patch (everything else)', () => {
    it('classifies `fix:` as patch', () => {
      expect(classifyCommitMessage('fix: off-by-one')).toBe('patch');
    });

    it('classifies scoped `fix(scope):` as patch', () => {
      expect(classifyCommitMessage('fix(parser): handle empty input')).toBe('patch');
    });

    it('classifies `chore:` as patch', () => {
      expect(classifyCommitMessage('chore: bump deps')).toBe('patch');
    });

    it('classifies `docs:` as patch', () => {
      expect(classifyCommitMessage('docs: update README')).toBe('patch');
    });

    it('classifies `refactor:` as patch', () => {
      expect(classifyCommitMessage('refactor: extract helper')).toBe('patch');
    });

    it('classifies non-conventional messages as patch', () => {
      expect(classifyCommitMessage('some random commit')).toBe('patch');
    });
  });

  describe('edge cases', () => {
    it('returns undefined for an empty message', () => {
      expect(classifyCommitMessage('')).toBeUndefined();
    });

    it('returns undefined for a whitespace-only message', () => {
      expect(classifyCommitMessage('   \n\n  ')).toBeUndefined();
    });

    it('does not treat `feature:` as a feat', () => {
      // Only exact `feat` type should promote to minor; `feature` is not a
      // Conventional Commits type and falls through to patch.
      expect(classifyCommitMessage('feature: something')).toBe('patch');
    });

    it('does not treat a mid-sentence "BREAKING CHANGE" without the colon as major', () => {
      // The colon is the conventional-commits signal; without it, this is
      // just prose in the body.
      expect(classifyCommitMessage('feat: this is NOT a BREAKING CHANGE really')).toBe('minor');
    });
  });

  // Regression guard: the classifier used to match `BREAKING CHANGE:` anywhere
  // in the message, so a commit that *documented* the rule declared a breaking
  // change against itself. Commit 0cd9b2b of this repo did exactly that and
  // promoted @proteinjs/build 1.9.2 -> 2.0.0 with no breaking change behind it.
  describe('documentation is not a declaration', () => {
    it('does not treat the real 0cd9b2b message (which documents the rule) as major', () => {
      const message = [
        'feat(version-workspace): detect commit-leaves + plan-only mode',
        '',
        'New `classifyUnpushedCommits(dir)` replaces the old boolean',
        '`hasFeatureCommits(dir)`. Classifies the net semver bump across all',
        'unpushed commits via Conventional Commits rules:',
        '',
        '  - `major` when any commit declares `BREAKING CHANGE:` in its',
        '    subject/body/footer, or uses the `!` marker (`feat!:`,',
        '    `fix(scope)!:`, …).',
        '  - `minor` when any commit is `feat(scope)?:`.',
        '  - `patch` for everything else.',
      ].join('\n');
      expect(classifyCommitMessage(message)).toBe('minor');
    });

    it('does not treat a backticked footer token at line start as major', () => {
      expect(classifyCommitMessage('docs: explain footers\n\n`BREAKING CHANGE:` promotes to major')).toBe('patch');
    });

    it('does not treat an indented footer token as major', () => {
      // Footers live at column 0; anything indented is a quote or list item.
      expect(classifyCommitMessage('fix: tighten parsing\n\n    BREAKING CHANGE: sample footer')).toBe('patch');
    });

    it('does not treat a footer token inside a fenced code block as major', () => {
      const message = [
        'docs: document the commit format',
        '',
        'Example of a breaking commit:',
        '',
        '```',
        'feat(api)!: drop v1',
        '',
        'BREAKING CHANGE: v1 endpoints removed',
        '```',
        '',
        'That is all.',
      ].join('\n');
      expect(classifyCommitMessage(message)).toBe('patch');
    });

    it('ignores everything after an unterminated code fence', () => {
      expect(classifyCommitMessage('docs: partial sample\n\n```\nBREAKING CHANGE: nope')).toBe('patch');
    });

    it('does not treat `feat:` mentioned inside the body as a minor', () => {
      // Only the header type drives the bump; body prose is inert.
      expect(classifyCommitMessage('fix: correct classifier\n\nthis is not a feat: something')).toBe('patch');
    });

    it('does not treat a body line that starts with `feat:` as a minor', () => {
      // Even at column 0 — the header is the only place a type is read from.
      expect(classifyCommitMessage('fix: correct classifier\n\nExample of a feature commit:\nfeat: add a thing')).toBe(
        'patch'
      );
    });

    it('does not treat a `!` marker mentioned inside the body as major', () => {
      expect(classifyCommitMessage('docs: describe markers\n\nfeat!: is how you declare a break')).toBe('patch');
    });
  });
});
