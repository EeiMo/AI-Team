/**
 * __mocks__/db/knex.ts
 * Jest mock for src/db/knex.ts
 * Redirects all PG knex imports to the test SQLite knex singleton.
 */

import { testKnex } from '../__tests__/shared/db';

export const knex = testKnex;
export default knex;
