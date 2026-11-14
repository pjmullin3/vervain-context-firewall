declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array, inputEncoding?: 'utf8'): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: { env?: Record<string, string | undefined>; encoding: 'utf8' },
  ): string;
}

declare const process: {
  env: Record<string, string | undefined>;
};

declare const Buffer: {
  from(input: string, encoding: 'utf8'): Uint8Array;
};
