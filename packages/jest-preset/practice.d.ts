/** ts-jest's floor, the one number (practice.js). */
export const TS_JEST_FLOOR: string;

/** A local module the config requires, read by the caller (`TestPractice.localRequires` names the specifiers). */
export interface ModuleRead {
  /** The module's path as the refusal names it (`test/ThoughtServerJestPreset.js`). */
  path: string;
  text: string;
}

export interface PackageRead {
  /** The package's dir, as the caller names it (the refusal's clause names it). */
  dir: string;
  /** The parsed package.json, or null when the tree has none that parses. */
  manifest: Record<string, any> | null;
  /** The jest.config.js text, or null when the tree has none. */
  config: string | null;
  /** The local modules the config requires, when the caller hands them in — read for P1's process reads. */
  modules?: ModuleRead[];
}

/** One line of a text that reads or writes the process (P1), with each kind it does once. */
export interface ProcessRead {
  /** 1-based. */
  line: number;
  kinds: string[];
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
  static NODE_OPTIONS_KEY: string;
  static REASON_KEY: string;
  static DECLARATION_KEYS: string[];
  static PRESET_KEYS: string[];
  /** P1's process reads — each kind (a write, NODE_OPTIONS / argv / execArgv / exit, and the process or its env held bare as a value) named with the regular expression that finds it on one blanked line. */
  static PROCESS_READS: { what: string; re: RegExp }[];
  /** The words a `/` may open a regex literal after (`return /x/`); `blank` reads division after any other name. */
  static REGEX_AFTER: Set<string>;
  static RULES: { P1: string; P2: string; P3: string };
  static drift(packages: PackageRead[]): PackageDrift[];
  static judge(read: {
    manifest: Record<string, any> | null;
    config: string | null;
    modules?: ModuleRead[];
  }): Deviation[];
  static underTheLaw(manifest: Record<string, any> | null, config: string | null): boolean;
  /** The lines of `text` that read or write the process (PROCESS_READS), over its blanked form (comments, prose strings, regex bodies). */
  static processReads(text: string): ProcessRead[];
  /** The `require('./…')` / `require('../…')` specifiers of a text, in order, each once. */
  static localRequires(text: string): string[];
  /** THE ONE STRIPPER: comments, regex bodies and (unless `strings` is false) string and template prose blanked in one tokenizing pass — a template's ${…} read as code — every line kept at its number. */
  static blank(text: string, options?: { strings?: boolean }): string;
  static describe(drift: PackageDrift[]): string;
  static readConfig(text: string): ConfigRead | null;
  static topLevelKeys(text: string): Map<string, string | null> | null;
  static exportedLiteral(text: string): string | null;
  static entriesOf(body: string): string[];
  static closeOf(src: string, open: number): number;
}
