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

    it('classifies `BREAKING CHANGE:` in subject as major', () => {
      expect(classifyCommitMessage('feat: BREAKING CHANGE: removed old flow')).toBe('major');
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
});
