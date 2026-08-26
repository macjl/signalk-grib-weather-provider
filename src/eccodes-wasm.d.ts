// Minimal type declarations for @meri-imperiumi/eccodes-wasm (the package
// itself ships without TypeScript types). Only the surface used by this
// plugin is declared.

declare module '@meri-imperiumi/eccodes-wasm' {
  export interface CodesHandle {
    getLong(key: string): number
    getDouble(key: string): number
    getString(key: string): string
    getDoubleArray(key: string): number[]
    getSize(key: string): number
    getNativeType(key: string): number
    isMissing(key: string): boolean
    clone(): CodesHandle
    // WASM memory is not garbage collected — handles must be deleted
    delete(): void
  }

  export interface Eccodes {
    getVersion(): number
    openGrib(path: string): CodesHandle
    openBufr(path: string): CodesHandle
    openFile(path: string, productKind?: number): CodesHandle
    countInFile(path: string): number
    setDefinitionsPath(path: string): void
    setSamplesPath(path: string): void
    mountFilesystem(root?: string): void
    writeFile(path: string, data: string | Buffer | Uint8Array): void
    readFile(path: string): Uint8Array
  }

  export function createEccodes(moduleOrPath?: unknown, options?: unknown): Promise<Eccodes>

  export class EccodesError extends Error {
    code: number
  }
}
