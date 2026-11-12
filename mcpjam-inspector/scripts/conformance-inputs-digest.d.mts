/** Types for the conformance inputs digest. */
export declare const NOT_CONFORMANCE_INPUTS: readonly string[];
export declare const CONFORMANCE_INPUT_EXCEPTIONS: readonly string[];
export declare function globToRegExp(glob: string): RegExp;
export declare function isConformanceInput(path: string): boolean;
export declare function normalizePackageJson(text: string, workspaceNames: Set<string>): string;
export declare function normalizePackageLock(text: string): string;
export declare function computeConformanceInputsDigest(options?: { cwd?: string; rev?: string }): string;
