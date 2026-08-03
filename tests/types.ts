import type {Reference} from 'firebase-admin/database';
import NodeFire, {type CacheStats, type ChildNodeFireOf} from '../src';

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type GetResult<T extends {get: (...args: any[]) => Promise<unknown>}> =
  Awaited<ReturnType<T['get']>>;

interface User {
  displayName: string;
  loginCount: number;
}

interface Organization {
  name: string;
  users: {$: User};
}

interface Database {
  organizations: {$: Organization};
  settings: {featureEnabled: boolean};
}

declare const reference: Reference;
const untyped = new NodeFire(reference);
const unusedCacheStats: CacheStats = NodeFire.getCacheStats();
const unusedCacheCount: number = unusedCacheStats.count;
const unusedCacheMaxSize: number = unusedCacheStats.maxSize;
const unusedCacheHits: number = unusedCacheStats.hits;
const unusedCacheMisses: number = unusedCacheStats.misses;
const unusedCacheHitRate: number = unusedCacheStats.hitRate;
NodeFire.resetCacheStats();
type UntypedParentResult = Expect<
  Equal<GetResult<NonNullable<typeof untyped.parent>>, unknown>
>;
const db = new NodeFire<Database>(reference);
const unusedTypedAsUntyped: NodeFire = db;
const unusedUntypedAsTyped: NodeFire<Database> = untyped;

const user = db.child('organizations/:organization/users/:user');
type UserResult = Expect<Equal<GetResult<typeof user>, User | null>>;
const unusedTransaction = user.transaction(value => value);
type TransactionResult = Expect<Equal<
  Awaited<typeof unusedTransaction>,
  User | null | undefined
>>;
const unusedTransactionOutcome: 'commit' | 'error' | 'skip' | undefined =
  unusedTransaction.transaction.outcome;
type InferredUser = Expect<Equal<
  typeof user extends NodeFire<
    infer Current, infer unusedRules, infer unusedWrite
  > ? Current : never,
  User
>>;
type UsersRef = NonNullable<typeof user.parent>;
type UsersResult = Expect<Equal<GetResult<UsersRef>, Organization['users'] | null>>;
type OrganizationRef = NonNullable<UsersRef['parent']>;
type OrganizationResult = Expect<Equal<GetResult<OrganizationRef>, Organization | null>>;
type OrganizationsRef = NonNullable<OrganizationRef['parent']>;
type OrganizationsResult = Expect<
  Equal<GetResult<OrganizationsRef>, Database['organizations'] | null>
>;
type DatabaseRef = NonNullable<OrganizationsRef['parent']>;
type DatabaseResult = Expect<Equal<GetResult<DatabaseRef>, Database | null>>;
type RootParent = Expect<Equal<DatabaseRef['parent'], null>>;

type RootResult = Expect<Equal<GetResult<typeof user.root>, Database | null>>;
type NavigatedRootParent = Expect<Equal<(typeof user.root)['parent'], null>>;
const unusedSettings = user.root.child('settings');
type SettingsResult = Expect<
  Equal<GetResult<typeof unusedSettings>, Database['settings'] | null>
>;

void user.root.set({
  organizations: {
    $: {name: 'Acme', users: {$: {displayName: 'Ada', loginCount: 1}}}
  },
  settings: {featureEnabled: true}
});
void user.parent?.set({$: {displayName: 'Ada', loginCount: 1}});
// @ts-expect-error The root reference must use the database write type, not the child write type.
void user.root.set({displayName: 'Ada', loginCount: 1});
// @ts-expect-error The parent reference must use the users write type, not the organization type.
void user.parent?.set({name: 'Acme', users: {$: {displayName: 'Ada', loginCount: 1}}});

const unusedChainedUser = db
  .child('organizations/:organization')
  .child('users/:user');
type ChainedParentResult = Expect<
  Equal<GetResult<NonNullable<typeof unusedChainedUser.parent>>, Organization['users'] | null>
>;
type ChainedGrandparentResult = Expect<
  Equal<
    GetResult<NonNullable<NonNullable<typeof unusedChainedUser.parent>['parent']>>,
    Organization | null
  >
>;

const unusedQueriedUser = user.orderByKey().limitToFirst(1).ref.scope({organization: 'acme'});
type QueryParentResult = Expect<
  Equal<GetResult<NonNullable<typeof unusedQueriedUser.parent>>, Organization['users'] | null>
>;
type QueryRootResult = Expect<Equal<GetResult<typeof unusedQueriedUser.root>, Database | null>>;

declare const runtimePath: string;
const unusedDynamicRef = db.child(runtimePath);
type DynamicResult = Expect<Equal<GetResult<typeof unusedDynamicRef>, unknown>>;
type DynamicParentResult = Expect<
  Equal<GetResult<NonNullable<typeof unusedDynamicRef.parent>>, unknown>
>;
type DynamicRootResult = Expect<Equal<GetResult<typeof unusedDynamicRef.root>, Database | null>>;

const users = db.child('organizations/:organization/users');
type RecreatedUsers = typeof users extends NodeFire<
  infer Current, infer Rules, infer WriteCurrent
> ? NodeFire<Current, Rules, WriteCurrent> : never;
type CompatibleRecreatedUsers = Expect<typeof users extends RecreatedUsers ? true : false>;
const unusedPushedUser = users.push({displayName: 'Ada', loginCount: 1});
type PushedUserRef = Awaited<typeof unusedPushedUser>;
type PushedUserResult = Expect<Equal<GetResult<PushedUserRef>, User | null>>;
type PushedParentResult = Expect<
  Equal<GetResult<NonNullable<PushedUserRef['parent']>>, Organization['users'] | null>
>;
type PushedRootResult = Expect<Equal<GetResult<PushedUserRef['root']>, Database | null>>;

function childAtRuntimeKey<Node extends NodeFire<any, readonly any[], any>>(
  node: Node,
  key: string
): ChildNodeFireOf<Node, '$'> {
  return node.child<'$'>(key);
}

const organizations = db.child('organizations');
const unusedOrganization = childAtRuntimeKey(organizations, 'acme');

type RuntimeOrganizationResult = Expect<
  Equal<GetResult<typeof unusedOrganization>, Organization | null>
>;

type RuntimeOrganizationParentResult = Expect<
  Equal<
    GetResult<NonNullable<typeof unusedOrganization.parent>>,
    Database['organizations'] | null
  >
>;

// Ensure the aliases above are checked even when noUnusedLocals is enabled.
export type NavigationTypeTests = [
  UntypedParentResult,
  UserResult,
  TransactionResult,
  InferredUser,
  UsersResult,
  OrganizationResult,
  OrganizationsResult,
  DatabaseResult,
  RootParent,
  RootResult,
  NavigatedRootParent,
  SettingsResult,
  ChainedParentResult,
  ChainedGrandparentResult,
  QueryParentResult,
  QueryRootResult,
  DynamicResult,
  DynamicParentResult,
  DynamicRootResult,
  CompatibleRecreatedUsers,
  PushedUserResult,
  PushedParentResult,
  PushedRootResult,
  RuntimeOrganizationResult,
  RuntimeOrganizationParentResult
];
