/** ts-jest's floor, the one number (practice.js). */
export const TS_JEST_FLOOR: string;

export interface PackageRead {
  /** The package's dir, as the caller names it (the refusal's clause names it). */
  dir: string;
  /** The parsed package.json, or null when the tree has none that parses. */
  manifest: Record<string, any> | null;
  /** The jest.config.js text, or null when the tree has none. */
  config: string | null;
}

export interface Deviation {
  rule: 'P1' | 'P2' | 'P3';
  detail: string;
}

export interface PackageDrift {
  dir: string;
  name: string;
  deviations: Deviation[];
}

export interface ConfigRead {
  /** Every top-level key → its value when a plain string literal, else null. */
  keys: Map<string, string | null>;
  /** The expressions the top-level spread entries carry. */
  spreads: string[];
}

/** THE ONE CI TEST PRACTICE's judge — a pure read of package.json + jest.config.js (practice.js states the rules). */
export class TestPractice {
  static PRESET: string;
  static OWN_PRESET: string;
  static SCRIPT: string;
  static CONFIG: string;
  static DECLARATION_KEY: string;
  static IN_BAND_KEY: string;
  static PRESET_KEYS: string[];
  static RULES: { P1: string; P2: string; P3: string };
  static drift(packages: PackageRead[]): PackageDrift[];
  static judge(read: { manifest: Record<string, any> | null; config: string | null }): Deviation[];
  static underTheLaw(manifest: Record<string, any> | null, config: string | null): boolean;
  static describe(drift: PackageDrift[]): string;
  static readConfig(text: string): ConfigRead | null;
  static topLevelKeys(text: string): Map<string, string | null> | null;
  static exportedLiteral(text: string): string | null;
  static entriesOf(body: string): string[];
  static closeOf(src: string, open: number): number;
  static stripComments(text: string): string;
}
