import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(process.cwd(), 'research', 'multibenchmark-manifest.json');
const p = JSON.parse(readFileSync(file, 'utf8')) as { benchmarks: Array<{id:string;status:string}> };
const statuses = new Map(p.benchmarks.map(b => [b.id, b.status]));
if (statuses.get('fever_v1') !== 'PROTOCOL_FROZEN_DATA_HASH_PENDING') throw new Error('FEVER must remain hash-pending until materialization produces a frozen digest');
if (statuses.get('feverous') !== 'PROTOCOL_FROZEN_DATA_HASH_PENDING') throw new Error('FEVEROUS must remain hash-pending until materialization produces a frozen digest');
if (statuses.get('averitec') !== 'PROTOCOL_FROZEN_DATA_HASH_PENDING') throw new Error('AVeriTeC must remain hash-pending until materialization produces a frozen digest');
console.log('Phase 2 materialization guard: external benchmark status remains honest until exact release hashes are recorded.');
