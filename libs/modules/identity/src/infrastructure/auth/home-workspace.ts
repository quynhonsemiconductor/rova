import { WORKSPACE_ID } from '../../../../../../db/seeds/constants';

/**
 * The install's home workspace: the one the tenant bootstrap creates (`db/seeds/bootstrap.ts`) and the one a staff sign-in
 * enrols a user into. Under identity 7 it was the `workspace_id` of the `sso_connections` home row, which the same
 * bootstrap wrote from this constant on every deploy; reading the constant is the same answer without a dependency on a
 * v7 table that is dropped at day 30.
 */
export const HOME_WORKSPACE_ID: string = WORKSPACE_ID;
