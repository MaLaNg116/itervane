import { z } from 'zod';

// Must run before shared object schemas are constructed: Zod caches JIT eligibility at construction.
z.config({ jitless: true });
