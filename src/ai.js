// Claude-powered features. Everything degrades gracefully when ANTHROPIC_API_KEY is not set.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_MODEL || 'claude-opus-5';
let client = null;
const enabled = () => !!(client || process.env.ANTHROPIC_API_KEY);
const getClient = () => (client ||= new Anthropic());

class AiError extends Error {}

/**
 * One Claude call. `data` goes into a cached system block (it is the large, stable part);
 * `schema` switches on structured JSON output.
 */
async function run({ instructions, data, prompt, schema, maxTokens = 8000, effort = 'medium' }) {
  if (!enabled()) throw new AiError('AI is not switched on yet — add ANTHROPIC_API_KEY on the server.');
  const system = [{ type: 'text', text: instructions }];
  if (data) system.push({ type: 'text', text: data, cache_control: { type: 'ephemeral' } });
  let res;
  try {
    res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      // If a safety classifier declines, Anthropic re-runs the request on its recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AiError('The AI key on the server is invalid.');
    if (err instanceof Anthropic.RateLimitError) throw new AiError('The AI is busy right now — please try again in a minute.');
    if (err instanceof Anthropic.APIConnectionError) throw new AiError('Could not reach the AI service — check the internet connection.');
    if (err instanceof Anthropic.APIError) throw new AiError(`AI service error (${err.status}). Please try again.`);
    throw err;
  }
  if (res.stop_reason === 'refusal') throw new AiError('The AI declined this request.');
  if (res.stop_reason === 'max_tokens') throw new AiError('The AI answer was too long — try a narrower question.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!schema) return text;
  try { return JSON.parse(text); } catch { throw new AiError('The AI returned an unexpected answer — please try again.'); }
}

// Tests inject a fake client with the same `beta.messages.create` shape.
const _setClient = (c) => { client = c; };

module.exports = { run, enabled, AiError, MODEL, _setClient };
