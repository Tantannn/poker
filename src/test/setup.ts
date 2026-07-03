// Vitest + Testing Library setup: unmount rendered trees between tests so DOM
// state and localStorage-backed components don't leak across cases.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
