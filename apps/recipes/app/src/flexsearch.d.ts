declare module 'flexsearch/dist/module/document' {
  export default class Document<T = unknown> {
    constructor(options?: Record<string, unknown>);
    add(id: string | number, doc: T): void;
    search(query: string, options?: Record<string, unknown>): Array<{ result: Array<string | number> }>;
    remove(id: string | number): void;
  }
}
