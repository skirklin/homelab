/// <reference types="vite/client" />

declare module 'flexsearch/dist/module/document' {
  export default class Document {
    constructor(options?: Record<string, unknown>);
    add(id: number, content: Record<string, unknown>): void;
    search(query: string, options?: Record<string, unknown>): Array<{ result: number[] }>;
  }
}
