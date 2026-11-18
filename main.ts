// Entry point: the harness lifecycle for this forge.
//
// The program talks to the grading environment ("env") through three steps:
//   1. Read MAKEFUN_ENV_URL — the env's origin. Without it there is nothing to
//      register with, so the process prints a message and exits 1 immediately.
//   2. Start the forge server on an ephemeral port (listen(0), so the kernel
//      picks a free one — never 8080, the env owns that) and POST the bound port
//      to $MAKEFUN_ENV_URL/register. The env then dials this process at the
//      address the request came from plus that port. A 200 means the register
//      landed; a 409 means some other entry registered first, which is fine —
//      this process just waits like any other. A 400 or 405 is a contract
//      error and ends the program; anything else (network failure, other
//      status) is retried, because the env may still be starting up.
//   3. Poll GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}.
//      The env answers each poll at once ({"done": false} while the suite is
//      still running), so this is a loop with a short sleep, not a long-held
//      request. A failed or slow poll is retried with exponential backoff;
//      the process never exits before the env says it is done.
//   4. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// Only the server built by app.ts is imported here: no package, no Node
// built-in module, no model call.

import { createApp } from './app.ts';

/** Origin of the grading env, trailing slashes stripped; empty when unset. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Longest a single register or done request may run before it is dropped. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff between retries: starts here, doubles per failure, stops growing here. */
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;
/** Largest exponent the doubling may reach, so the delay never overshoots the ceiling by much. */
const BACKOFF_MAX_STEP = 8;

/** Resolve after `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Delay before the next retry after `failures` consecutive failed attempts. */
function backoffDelay(failures: number): number {
  const step = Math.min(failures, BACKOFF_MAX_STEP);
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** step);
}

/**
 * POST the bound port to the env until it is accepted. Returns on 200 (registered)
 * or 409 (another entry registered first — not ours to fix). Throws on 400/405,
 * which are contract errors; any other outcome is retried after a backoff.
 */
async function registerPort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // Anything else is a transient failure (env still starting, network hiccup):
      // fall through to the backoff below.
    }
    await pause(backoffDelay(failures));
    failures += 1;
  }
}

/**
 * Poll GET /done until the env reports {"done": true}. A non-OK answer, a body
 * without done === true, a network error, or a timeout all mean "not done yet":
 * sleep and poll again.
 */
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await pause(backoffDelay(failures));
    failures += 1;
  }
}

/** Start the server, register its port, wait for the env, then shut down. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
