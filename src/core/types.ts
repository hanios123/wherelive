/** The comparisons `where(field, op, value)` understands. */
export type Comparison = '==' | '!=' | '>' | '>=' | '<' | '<=';

/** An object used as a dictionary: `{ [id]: item }`. */
export type Holder<V> = { [key: string]: V };

export type Unsubscribe = () => void;

/**
 * The smallest framework-neutral subscription contract. React, Vue, Angular and
 * Svelte adapters can all be written against this without the core knowing them.
 */
export interface Subscription<T> {
  subscribe(next: (value: T) => void, error?: (error: unknown) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Attribute typing. `select('name', 'contact.*')` is checked against the row type.
// ---------------------------------------------------------------------------

/** The nested object a `x.*` attribute copies onto the result. Arrays and functions are not spread. */
type Spreadable<V> =
  NonNullable<V> extends readonly unknown[]
    ? never
    : NonNullable<V> extends (...args: never[]) => unknown
      ? never
      : NonNullable<V> extends object
        ? NonNullable<V>
        : never;

type SelectableKey<T> = {
  [K in keyof T & string]-?: K | ([Spreadable<T[K]>] extends [never] ? never : `${K}.*`);
}[keyof T & string];

/** The names `select` accepts on a row of type `T`: a key, `key.*` for an object-valued key, or `*` for the whole row. */
export type AttributeName<T> = SelectableKey<T> | '*';

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;
type IsUnion<U> = [U] extends [UnionToIntersection<U>] ? false : true;
type PartOf<T, A extends string> = A extends `${infer K}.*`
  ? K extends keyof T
    ? Spreadable<T[K]>
    : never
  : A extends keyof T
    ? { [P in A]: T[P] }
    : never;

/**
 * What `select(...names)` returns per row: the bare value for one plain name,
 * otherwise an object holding only the selected attributes.
 */
export type Selected<T, A extends string> = '*' extends A
  ? T
  : IsUnion<A> extends true
    ? Simplify<UnionToIntersection<PartOf<T, A>>>
    : A extends `${string}.*`
      ? Simplify<PartOf<T, A>>
      : A extends keyof T
        ? T[A]
        : never;

/** One selected attribute changing value. `value` is `undefined` when the attribute is absent. */
export type AttributeChange<T, A extends string> = A extends '*'
  ? { readonly attribute: '*'; readonly value: T | undefined }
  : A extends `${infer K}.*`
    ? K extends keyof T
      ? {
          [P in keyof Spreadable<T[K]> & string]: {
            readonly attribute: `${K}.${P}`;
            readonly value: Spreadable<T[K]>[P] | undefined;
          };
        }[keyof Spreadable<T[K]> & string]
      : never
    : A extends keyof T
      ? { readonly attribute: A; readonly value: T[A] | undefined }
      : never;

/**
 * An attribute change inside a list of rows. `key` says which row. A row that
 * left the result arrives once as `{ attribute: '*', removed: true }`.
 */
export type RowChange<T, A extends string> =
  | (AttributeChange<T, A> & { readonly key: string; readonly removed?: false })
  | { readonly key: string; readonly attribute: '*'; readonly value: undefined; readonly removed: true };

type Leafish = string | number | boolean | bigint | symbol | null | undefined | Date | ((...args: never[]) => unknown) | readonly unknown[];

type PathImpl<T, Depth extends unknown[]> = Depth['length'] extends 4
  ? never
  : T extends Leafish
    ? never
    : {
        [K in keyof T & string]-?: K | (NonNullable<T[K]> extends Leafish ? never : `${K}.${PathImpl<NonNullable<T[K]>, [...Depth, 0]>}`);
      }[keyof T & string];

/** A field of `T`, or a dotted path to a nested field, up to four levels deep: `'city'`, `'customer.address.city'`. */
export type Path<T> = PathImpl<T, []>;

/** The type at a path. Across a union of row types it is the union of what each member has there. */
export type PathValue<T, P extends string> = T extends unknown
  ? P extends `${infer K}.${infer Rest}`
    ? K extends keyof T
      ? PathValue<NonNullable<T[K]>, Rest>
      : never
    : P extends keyof T
      ? T[P]
      : never
  : never;

/** Paths whose value is an array, for `whereIncludes`. */
export type ArrayPath<T> = { [P in Path<T>]: NonNullable<PathValue<T, P>> extends readonly unknown[] ? P : never }[Path<T>];

/** Paths whose value is a number, for `sum` and `avg`. */
export type NumberPath<T> = { [P in Path<T>]: PathValue<T, P> extends number | null | undefined ? P : never }[Path<T>];

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type ArrayElement<V> = NonNullable<V> extends readonly (infer E)[] ? E : never;

/** Keys of `T` whose value can be used as an object key, for `toHolder`. */
export type HolderKey<T> = {
  [K in keyof T & string]-?: T[K] extends string | number ? K : never;
}[keyof T & string];
