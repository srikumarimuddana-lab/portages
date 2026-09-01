/**
 * AI Gateway smoke test.
 *
 * Proves three things in one run, in the order they can fail:
 *   1. credentials resolve  (AI_GATEWAY_API_KEY, or the OIDC token `vercel env pull` writes)
 *   2. the Gateway is reachable
 *   3. a model streams tokens back
 *
 * Run it after `vercel link && vercel env pull`, before wiring anything else.
 * If this fails, nothing downstream can work, and the failure here is far
 * easier to read than the same failure surfacing inside a search request.
 *
 *   npm install ai
 *   node --experimental-strip-types scripts/verify-gateway.ts
 *   node --experimental-strip-types scripts/verify-gateway.ts --model anthropic/claude-haiku-4-5
 *
 * NOTE ON THE DEFAULT MODEL. `openai/gpt-5.6-sol` is the model from Vercel's
 * own onboarding snippet and is kept as the default so this script verifies
 * exactly what their docs verify. It is NOT what Portage runs on: the AI
 * features use Claude (analysis/06 §"AI / LLM"), routed through the same
 * Gateway. Pass --model to check the one you actually intend to use — proving
 * the Gateway works for a model you will never call is a weaker result than
 * it looks.
 */

// The Vercel AI SDK, loaded dynamically rather than with a static import.
//
// That is not stylistic. A static `import { streamText } from 'ai'` fails at
// module-resolution time, BEFORE any statement in this file runs — so the
// "package is not installed" message at the bottom becomes unreachable and
// the user gets a raw ERR_MODULE_NOT_FOUND stack instead. Measured, not
// assumed: that is exactly what this script printed before the change.
type StreamText = (opts: { model: string; prompt: string }) => {
  textStream: AsyncIterable<string>;
  usage: Promise<{ inputTokens?: number; outputTokens?: number }>;
};

async function loadSdk(): Promise<StreamText> {
  try {
    const mod = await import('ai');
    return (mod as { streamText: StreamText }).streamText;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(message)) {
      throw new Error('MISSING_SDK');
    }
    throw err;
  }
}

interface Options {
  model: string;
  prompt: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    model: 'openai/gpt-5.6-sol',
    prompt: 'In one sentence, confirm you are reachable and name the model answering.',
  };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--model' && next) { opts.model = next; i++; }
    else if (argv[i] === '--prompt' && next) { opts.prompt = next; i++; }
  }
  return opts;
}

/**
 * Says what is missing before spending a request to find out.
 *
 * The Gateway accepts either an explicit API key or the OIDC token Vercel
 * provisions automatically — `vercel env pull` writes the latter into
 * .env.local, which is why the setup order in docs/setup/vercel-ai-gateway.md
 * has `vercel link` before anything else.
 */
function preflight(): string | null {
  const key = process.env['AI_GATEWAY_API_KEY'];
  const oidc = process.env['VERCEL_OIDC_TOKEN'];
  if (key || oidc) return null;
  return [
    'No Gateway credentials found.',
    '',
    'Expected one of:',
    '  AI_GATEWAY_API_KEY   an explicit key from the Vercel dashboard',
    '  VERCEL_OIDC_TOKEN    provisioned automatically; written by `vercel env pull`',
    '',
    'Fix:  vercel link  &&  vercel env pull',
    'Then re-run with the env loaded (e.g. `set -a; . .env.local; set +a`).',
  ].join('\n');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const missing = preflight();
  if (missing) {
    console.error(missing);
    process.exit(2);
  }

  const streamText = await loadSdk();

  console.error(`→ ${opts.model} via AI Gateway`);
  const startedAt = Date.now();

  const result = streamText({
    model: opts.model,
    prompt: opts.prompt,
  });

  let chars = 0;
  // Streaming rather than awaiting the whole reply: it verifies tokens are
  // actually flowing, which a buffered call cannot distinguish from a slow
  // one that returns all at once.
  for await (const part of result.textStream) {
    chars += part.length;
    process.stdout.write(part);
  }
  process.stdout.write('\n');

  const usage = await result.usage;
  console.error(
    `✓ ${chars} chars in ${Date.now() - startedAt}ms · ` +
    `in ${usage.inputTokens ?? '?'} / out ${usage.outputTokens ?? '?'} tokens`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  // The three failures worth naming, because each has a different fix and the
  // raw message for all three is some variation of "request failed".
  if (message === 'MISSING_SDK') {
    console.error('The `ai` package is not installed.  Fix:  npm install ai');
  } else if (/401|403|unauthor|forbidden/i.test(message)) {
    console.error(`Gateway rejected the credentials: ${message}`);
    console.error('Fix:  vercel env pull   (the OIDC token is short-lived and expires)');
  } else if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|tunnel/i.test(message)) {
    console.error(`Cannot reach the Gateway: ${message}`);
    console.error('Check egress to ai-gateway.vercel.sh.');
  } else {
    console.error(message);
  }
  process.exit(1);
});
